import { mkdirSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import { readLocalMarkdown, MAX_MARKDOWN_BYTES } from '../../src/server/markdown.js';
import { GatewayService } from '../../src/server/service.js';
import { harness, operationId, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) resource.close();
});
async function setup() {
  const resource = harness();
  resources.push(resource);
  const { directory, service, project } = resource;
  const config = parseConfig(
    { projects: [{ id: 'project', name: 'Test', path: project }] },
    join(directory, 'config.json'),
  );
  const app = createApp({ config, service, staticDir: directory });
  const op = await service.createThread('project', { clientOperationId: operationId() });
  const threadId = (op.result as { threadId: string }).threadId;
  const url = (path?: string, id = threadId) =>
    `http://127.0.0.1:8787/api/threads/${id}/markdown${path === undefined ? '' : `?${new URLSearchParams({ path })}`}`;
  return { ...resource, config, app, threadId, url };
}

it('returns exact UTF-8 text and a trusted base path with private response headers', async () => {
  const { app, url, project } = await setup();
  const name = '方案 100%20.MD';
  const content = '\uFEFF# 方案\r\n\r\n- **格式**\r\n\t保留缩进\r\n';
  writeFileSync(join(project, name), content);
  for (const path of [name, `./${name}`, join(project, name)]) {
    const response = await app.request(url(path));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: realpathSync(join(project, name)), content });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  }
});

it('resolves from the session cwd and shares the image project/temp root union', async () => {
  const { app, project, directory, codex, url } = await setup();
  mkdirSync(join(project, 'nested'));
  writeFileSync(join(project, 'plan.md'), '# 项目');
  writeFileSync(join(directory, 'temporary.markdown'), '# 临时');
  codex.threads.set('nested', threadView('nested', join(project, 'nested')));
  expect((await app.request(url('../plan.md', 'nested'))).status).toBe(200);
  expect((await app.request(url(join(directory, 'temporary.markdown')))).status).toBe(200);
});

it('rejects traversal and symlink escapes outside an explicit authorized root union', async () => {
  const { project, directory } = await setup();
  const outside = join(directory, 'project-sibling');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.md'), '# 私有');
  symlinkSync(outside, join(project, 'escape'));
  symlinkSync(join(outside, 'secret.md'), join(project, 'escape.md'));
  const scope = {
    cwd: project,
    roots: [{ canonicalRoot: realpathSync(project), aliases: [project] }],
  };
  for (const path of [
    '../project-sibling/secret.md',
    join(outside, 'secret.md'),
    'escape/secret.md',
    'escape.md',
  ])
    await expect(readLocalMarkdown(path, scope)).rejects.toMatchObject({
      code: 'MARKDOWN_OUTSIDE_PROJECT',
      status: 403,
    });
});

it('preserves archived/offline authorization after restart and revokes it when the project is removed', async () => {
  const { service, store, projects, codex, project, threadId } = await setup();
  writeFileSync(join(project, 'saved.md'), '# 已保存');
  await service.setThreadArchived(threadId, { clientOperationId: operationId(), archived: true });
  codex.ready = false;
  const metadata = vi.spyOn(codex, 'readThreadMetadata').mockRejectedValue(new Error('offline'));
  const restarted = new GatewayService({ store, projects, codex });
  try {
    expect((await restarted.getThreadMarkdown(threadId, 'saved.md')).content).toBe('# 已保存');
    expect(metadata).not.toHaveBeenCalled();
    restarted.removeProject('project');
    await expect(restarted.getThreadMarkdown(threadId, 'saved.md')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  } finally {
    await restarted.shutdown();
  }
});

it('rejects URLs, control characters, unsupported, missing, binary and oversized files', async () => {
  const { app, project, url } = await setup();
  for (const path of [
    undefined,
    '',
    'https://example.com/a.md',
    'file:///a.md',
    '//host/a.md',
    'a\0.md',
    'a'.repeat(4097),
  ]) {
    const response = await app.request(url(path));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_MARKDOWN_PATH' } });
  }
  mkdirSync(join(project, 'dir.md'));
  writeFileSync(join(project, 'binary.md'), Buffer.from([0xff, 0xfe]));
  writeFileSync(join(project, 'null.md'), 'a\0b');
  writeFileSync(join(project, 'huge.md'), '# Large');
  truncateSync(join(project, 'huge.md'), MAX_MARKDOWN_BYTES + 1);
  for (const [path, status, code] of [
    ['missing.md', 404, 'MARKDOWN_NOT_FOUND'],
    ['dir.md', 415, 'MARKDOWN_NOT_FILE'],
    ['code.ts', 415, 'UNSUPPORTED_MARKDOWN_TYPE'],
    ['binary.md', 415, 'INVALID_MARKDOWN_CONTENT'],
    ['null.md', 415, 'INVALID_MARKDOWN_CONTENT'],
    ['huge.md', 413, 'MARKDOWN_TOO_LARGE'],
  ] as const) {
    const response = await app.request(url(path));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  }
  writeFileSync(join(project, 'empty.md'), '');
  expect((await app.request(url('empty.md'))).status).toBe(200);
});

it('enforces gateway authentication before touching files and never accepts a client cwd', async () => {
  const { app, service, url, project } = await setup();
  writeFileSync(join(project, 'saved.md'), '# Saved');
  const read = vi.spyOn(service, 'getThreadMarkdown');
  for (const headers of [
    { Host: 'foreign.invalid' },
    { Origin: 'https://foreign.invalid' },
  ] as Record<string, string>[]) {
    expect((await app.request(url('saved.md'), { headers })).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  }
  expect((await app.request(`${url('saved.md')}&cwd=/etc&root=/`)).status).toBe(200);
});
