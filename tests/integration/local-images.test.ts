import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { createAuthenticator } from '../../src/server/auth.js';
import { parseConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/http.js';
import {
  MAX_LOCAL_IMAGE_BYTES,
  readLocalImage,
  temporaryImageRoots,
} from '../../src/server/images.js';
import { GatewayService } from '../../src/server/service.js';
import { harness, operationId, threadView } from './domain-helpers.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const resources: ReturnType<typeof harness>[] = [];
const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const resource of resources.splice(0)) resource.close();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  const resource = harness();
  resources.push(resource);
  const { service, directory, project } = resource;
  const config = parseConfig(
    {
      dataDir: join(directory, 'data'),
      projects: [{ id: 'project', name: 'Test', path: project }],
    },
    join(directory, 'config.json'),
  );
  const app = createApp({ config, service, staticDir: directory });
  const created = await service.createThread('project', { clientOperationId: operationId() });
  const threadId = (created.result as { threadId: string }).threadId;
  const url = (path?: string, id = threadId) =>
    `http://127.0.0.1:8787/api/threads/${id}/images${path === undefined ? '' : `?${new URLSearchParams({ path })}`}`;
  return { ...resource, config, app, threadId, url };
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

it('serves actual image bytes for absolute/relative paths, Chinese, spaces and literal percent names', async () => {
  const { app, project, url } = await setup();
  const filename = '输出 图片 100%20.png';
  writeFileSync(join(project, filename), png);
  for (const path of [filename, `./${filename}`, join(project, filename)]) {
    const response = await app.request(url(path));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Length')).toBe(String(png.length));
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  }
});

it.each([
  ['PNG', png, 'image/png'],
  ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
  ['jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe1]), 'image/jpeg'],
  ['gif', Buffer.from('GIF89a'), 'image/gif'],
  ['webp', Buffer.from('RIFF\x04\x00\x00\x00WEBP'), 'image/webp'],
])('checks and returns the corresponding raster type for .%s', async (extension, bytes, mime) => {
  const { app, project, url } = await setup();
  const filename = `image.${extension}`;
  writeFileSync(join(project, filename), bytes);
  const response = await app.request(url(filename));
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe(mime);
});

it('resolves relative paths from the trusted session cwd and permits sibling project images', async () => {
  const { app, codex, project, url } = await setup();
  const cwd = join(project, 'nested');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'local.png'), png);
  writeFileSync(join(project, 'sibling.png'), png);
  codex.threads.set('nested-history', threadView('nested-history', cwd));
  expect((await app.request(url('local.png', 'nested-history'))).status).toBe(200);
  expect((await app.request(url('../sibling.png', 'nested-history'))).status).toBe(200);
});

it('uses persisted authorization for archived history after restarting while Codex is unavailable', async () => {
  const { app, codex, projects, project, service, store, directory, config, url, threadId } =
    await setup();
  writeFileSync(join(project, 'saved.png'), png);
  await service.setThreadArchived(threadId, { clientOperationId: operationId(), archived: true });
  codex.ready = false;
  const metadata = vi.spyOn(codex, 'readThreadMetadata').mockRejectedValue(new Error('offline'));
  const history = vi.spyOn(codex, 'readThread').mockRejectedValue(new Error('offline'));
  expect((await app.request(url('saved.png'))).status).toBe(200);
  const restarted = new GatewayService({ store, projects, codex });
  const restartedApp = createApp({ config, service: restarted, staticDir: directory });
  try {
    expect((await restartedApp.request(url('saved.png'))).status).toBe(200);
    expect(metadata).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  } finally {
    await restarted.shutdown();
  }
});

it('allows paths and symlinks into server temp directories even outside the current project', async () => {
  const { app, projects, project, directory, url } = await setup();
  const outside = join(directory, 'project-sibling');
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.png'), png);
  projects.add({ path: outside, name: 'Other project' });
  symlinkSync(outside, join(project, 'outside-directory'));
  symlinkSync(join(outside, 'private.png'), join(project, 'outside-file.png'));
  for (const path of [
    '../project-sibling/private.png',
    join(outside, 'private.png'),
    'outside-directory/private.png',
    'outside-file.png',
  ])
    expect((await app.request(url(path))).status).toBe(200);
  const encodedTraversal = url().concat('?path=%2e%2e%2fproject-sibling%2fprivate.png');
  expect((await app.request(encodedTraversal)).status).toBe(200);
});

it('serves files from the runtime temp directory and POSIX /tmp including canonical aliases', async () => {
  const { app, project, url } = await setup();
  for (const root of new Set([tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])])) {
    const directory = mkdtempSync(join(root, 'codex-image-temp-'));
    temporaryDirectories.push(directory);
    const path = join(directory, '临时 图片.png');
    writeFileSync(path, png);
    for (const spelling of [path, realpathSync(path)]) {
      const response = await app.request(url(spelling));
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    }
    writeFileSync(join(project, 'project.png'), png);
    const linked = join(directory, 'project-link.png');
    symlinkSync(join(project, 'project.png'), linked);
    expect((await app.request(url(linked))).status).toBe(200);
  }
});

it('rejects traversal, sibling prefixes and symlink escape beyond the authorized root union', async () => {
  const { project, directory } = await setup();
  const temporary = join(directory, 'trusted-temp');
  const outside = join(directory, 'trusted-temp-sibling');
  mkdirSync(temporary);
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.png'), png);
  symlinkSync(outside, join(project, 'outside-directory'));
  symlinkSync(join(outside, 'private.png'), join(temporary, 'outside-file.png'));
  const scope = {
    cwd: realpathSync(project),
    roots: [project, temporary].map((path) => ({
      canonicalRoot: realpathSync(path),
      aliases: [path],
    })),
  };
  for (const path of [
    '../trusted-temp-sibling/private.png',
    join(outside, 'private.png'),
    'outside-directory/private.png',
    join(temporary, 'outside-file.png'),
  ])
    await expect(readLocalImage(path, scope)).rejects.toMatchObject({
      code: 'IMAGE_OUTSIDE_PROJECT',
      status: 403,
    });
});

it.skipIf(process.platform === 'win32')(
  'rejects HTTP paths and symlinks beyond project/temp roots',
  async () => {
    const { app, project, url } = await setup();
    symlinkSync('/etc/hosts', join(project, 'outside-file.png'));
    await expectError(await app.request(url('outside-file.png')), 403, 'IMAGE_OUTSIDE_PROJECT');
    const response = await app.request(`${url('/etc/private.png')}&root=/&cwd=/etc`);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'IMAGE_OUTSIDE_PROJECT',
        message: '只能预览当前会话所属项目或服务器临时目录内的图片',
      },
    });
    expect(response.status).toBe(403);
    const traversal = `${'../'.repeat(project.split(sep).length)}etc/private.png`;
    const encodedTraversal = url().concat('?path=', traversal.replaceAll('../', '%2e%2e%2f'));
    await expectError(await app.request(encodedTraversal), 403, 'IMAGE_OUTSIDE_PROJECT');
  },
);

it('captures canonical temp aliases once and does not broaden scope when an alias changes', async () => {
  const { directory } = await setup();
  const original = join(directory, 'original-temp');
  const replacement = join(directory, 'replacement-temp');
  const alias = join(directory, 'temp-alias');
  mkdirSync(original);
  mkdirSync(replacement);
  writeFileSync(join(original, 'image.png'), png);
  writeFileSync(join(replacement, 'image.png'), png);
  symlinkSync(original, alias);
  vi.stubEnv(process.platform === 'win32' ? 'TEMP' : 'TMPDIR', alias);
  const roots = temporaryImageRoots().filter((root) => root.aliases.includes(alias));
  expect(roots).toEqual([{ canonicalRoot: realpathSync(original), aliases: [alias] }]);
  expect((await readLocalImage(join(alias, 'image.png'), { cwd: original, roots })).bytes).toEqual(
    png,
  );
  unlinkSync(alias);
  symlinkSync(replacement, alias);
  await expect(
    readLocalImage(join(alias, 'image.png'), { cwd: original, roots }),
  ).rejects.toMatchObject({ code: 'IMAGE_OUTSIDE_PROJECT' });
});

it('never authorizes filesystem roots, relative paths, files or unavailable temp directories', async () => {
  const { directory } = await setup();
  const file = join(directory, 'file.png');
  const rootAlias = join(directory, 'root-alias');
  writeFileSync(file, png);
  symlinkSync(parse(directory).root, rootAlias);
  for (const invalid of [
    parse(directory).root,
    rootAlias,
    'relative-temp',
    file,
    join(directory, 'missing'),
  ]) {
    vi.stubEnv(process.platform === 'win32' ? 'TEMP' : 'TMPDIR', invalid);
    const roots = temporaryImageRoots();
    expect(roots.every((root) => root.canonicalRoot !== parse(root.canonicalRoot).root)).toBe(true);
    expect(roots.flatMap((root) => root.aliases)).not.toContain(invalid);
  }
});

it('rejects an unregistered session and a removed owning project', async () => {
  const { app, codex, directory, service, project, url } = await setup();
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.png'), png);
  codex.threads.set('unregistered', threadView('unregistered', outside));
  await expectError(
    await app.request(url('private.png', 'unregistered')),
    403,
    'PROJECT_OWNERSHIP',
  );
  writeFileSync(join(project, 'saved.png'), png);
  service.removeProject('project');
  await expectError(await app.request(url('saved.png')), 404, 'PROJECT_NOT_FOUND');
});

it('does not trust a cwd query parameter or permit URL, network, control-character and oversized paths', async () => {
  const { app, project, url } = await setup();
  for (const path of [
    undefined,
    '',
    'file:///etc/private.png',
    'file://remote/private.png',
    'https://example.com/image.png',
    'data:image/png;base64,AAAA',
    '//remote/image.png',
    '\\\\remote\\image.png',
    'image\0.png',
    'x'.repeat(4097),
  ])
    await expectError(await app.request(url(path)), 400, 'INVALID_IMAGE_PATH');
  writeFileSync(join(project, 'saved.png'), png);
  expect((await app.request(`${url('saved.png')}&cwd=/etc`)).status).toBe(200);
});

it('reports missing files, directories, unsupported types, mismatched signatures and oversized files', async () => {
  const { app, project, url } = await setup();
  mkdirSync(join(project, 'directory.png'));
  writeFileSync(join(project, 'active.svg'), '<svg onload="alert(1)"/>');
  writeFileSync(join(project, 'pretend.png'), '<html>not an image</html>');
  writeFileSync(join(project, 'wrong.jpeg'), png);
  writeFileSync(
    join(project, 'wrong.gif'),
    Buffer.from('GIF89a').map((byte) => byte | 0x80),
  );
  writeFileSync(join(project, 'empty.png'), '');
  writeFileSync(join(project, 'huge.png'), png);
  truncateSync(join(project, 'huge.png'), MAX_LOCAL_IMAGE_BYTES + 1);
  for (const [path, status, code] of [
    ['missing.png', 404, 'IMAGE_NOT_FOUND'],
    ['directory.png', 415, 'IMAGE_NOT_FILE'],
    ['active.svg', 415, 'UNSUPPORTED_IMAGE_TYPE'],
    ['pretend.png', 415, 'INVALID_IMAGE_CONTENT'],
    ['wrong.jpeg', 415, 'INVALID_IMAGE_CONTENT'],
    ['wrong.gif', 415, 'INVALID_IMAGE_CONTENT'],
    ['empty.png', 415, 'INVALID_IMAGE_CONTENT'],
    ['huge.png', 413, 'IMAGE_TOO_LARGE'],
  ] as const) {
    const response = await app.request(url(path));
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expectError(response, status, code);
  }
});

it.skipIf(process.getuid?.() === 0)('reports a file that is not readable', async () => {
  const { app, project, url } = await setup();
  const path = join(project, 'unreadable.png');
  writeFileSync(path, png);
  chmodSync(path, 0);
  try {
    await expectError(await app.request(url(path)), 403, 'IMAGE_UNREADABLE');
  } finally {
    chmodSync(path, 0o600);
  }
});

it('enforces host/origin validation and Cloudflare authentication before reading files', async () => {
  const { app, service, directory, project, url } = await setup();
  writeFileSync(join(project, 'saved.png'), png);
  const read = vi.spyOn(service, 'getThreadImage');
  await expectError(
    await app.request(url('saved.png'), { headers: { Host: 'foreign.invalid' } }),
    403,
    'INVALID_HOST',
  );
  await expectError(
    await app.request(url('saved.png'), { headers: { Origin: 'https://foreign.invalid' } }),
    403,
    'INVALID_ORIGIN',
  );
  const config = parseConfig(
    {
      publicOrigin: ['https://codex.example.com'],
      auth: {
        mode: 'cloudflare-access',
        issuer: 'https://team.cloudflareaccess.com',
        audience: 'app-aud',
      },
    },
    join(directory, 'config.json'),
  );
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const accessApp = createApp({
    config,
    service,
    staticDir: directory,
    authenticate: createAuthenticator(config, publicKey),
  });
  const accessUrl = url('saved.png').replace('http://127.0.0.1:8787', 'https://codex.example.com');
  await expectError(await accessApp.request(accessUrl), 401, 'UNAUTHENTICATED');
  expect(read).not.toHaveBeenCalled();
  const token = await new SignJWT({ sub: 'owner' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('https://team.cloudflareaccess.com')
    .setAudience('app-aud')
    .setExpirationTime('1h')
    .sign(privateKey);
  expect(
    (await accessApp.request(accessUrl, { headers: { 'cf-access-jwt-assertion': token } })).status,
  ).toBe(200);
});
