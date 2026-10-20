import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayService } from '../../src/server/service.js';
import { ProjectRegistry } from '../../src/server/projects.js';
import { WorkspaceRegistry } from '../../src/server/workspaces.js';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import { databaseHarness } from './domain-db-helpers.js';
import { DomainCodex, operationId, threadView } from './domain-helpers.js';

describe('unassigned persistent workspaces', () => {
  let db: ReturnType<typeof databaseHarness>;
  let codex: DomainCodex;
  let projects: ProjectRegistry;
  let service: GatewayService;
  let root: string;
  const start = () =>
    new GatewayService({ store: db.store, projects, codex, workspacesRoot: root });
  const create = async (id = operationId()) => {
    const operation = await service.createThread(null, { clientOperationId: id });
    return service.getThread((operation.result as { threadId: string }).threadId);
  };
  const send = async (id: string) => {
    const operation = await service.startTurn(id, {
      clientOperationId: operationId(),
      text: 'hello',
    });
    codex.complete(id, (operation.result as { turnId: string }).turnId);
  };
  beforeEach(() => {
    db = databaseHarness();
    root = join(db.directory, 'data', 'workspaces');
    codex = new DomainCodex();
    projects = new ProjectRegistry([], db.db.database);
    service = start();
  });
  afterEach(async () => {
    await service.shutdown();
    db.close();
  });

  it('does not allocate session directories while browsing an empty workspace', async () => {
    expect((await service.listThreadSummaries(null)).data).toEqual([]);
    expect(existsSync(root)).toBe(false);
    await service.readRuntimeSettings(null);
    expect(readdirSync(root)).toEqual([]);
    expect(service.listProjects()).toEqual([]);
  });

  it('rejects cloning into managed session directories before writing any files', async () => {
    const thread = await create();
    const alias = join(db.directory, 'workspace-alias');
    symlinkSync(root, alias);
    for (const path of [join(root, 'clone'), join(thread.cwd, 'clone'), join(alias, 'clone')]) {
      expect(() =>
        service.cloneProject({
          clientOperationId: operationId(),
          repository: 'https://example.test/repository.git',
          path,
        }),
      ).toThrow(expect.objectContaining({ code: 'PROJECT_OWNERSHIP' }));
      expect(existsSync(path)).toBe(false);
    }
    expect(service.projectClones.hasActive).toBe(false);
    expect(service.listProjects()).toEqual([]);
  });

  it('allocates distinct directories concurrently and deduplicates the same operation', async () => {
    const id = operationId();
    await Promise.all([create(id), service.createThread(null, { clientOperationId: id })]);
    const [first, second] = await Promise.all([create(), create()]);
    expect(codex.creates).toBe(3);
    expect(first.projectId).toBeNull();
    expect(second.cwd).not.toBe(first.cwd);
    expect(readdirSync(root)).toHaveLength(3);
    expect(db.store.getThreadLink(first.id)?.projectId).toBeNull();
    expect((await service.listThreads(null)).data).toEqual([]);
    await send(first.id);
    expect((await service.listThreads(null)).data.map((entry) => entry.id)).toEqual([first.id]);
  });

  it('preserves the same directory and artifacts through rename, archive and gateway restart', async () => {
    const thread = await create();
    await send(thread.id);
    writeFileSync(join(thread.cwd, 'output.md'), '# Saved output');
    await service.renameThread(thread.id, { clientOperationId: operationId(), name: 'Saved work' });
    await service.setThreadArchived(thread.id, {
      clientOperationId: operationId(),
      archived: true,
    });
    expect((await service.listThreads(null)).data).toEqual([]);
    expect((await service.listThreads(null, undefined, true)).data[0]?.title).toBe('Saved work');
    await service.shutdown();
    codex.epoch = 'restarted';
    codex.ready = true;
    projects = new ProjectRegistry([], db.db.database);
    service = start();
    expect(await service.getThread(thread.id)).toMatchObject({
      cwd: thread.cwd,
      projectId: null,
      archived: true,
    });
    expect(await service.getThreadMarkdown(thread.id, 'output.md')).toMatchObject({
      content: '# Saved output',
    });
    await service.setThreadArchived(thread.id, {
      clientOperationId: operationId(),
      archived: false,
    });
    await service.resumeThread(thread.id, { clientOperationId: operationId() });
    await send(thread.id);
    expect(readdirSync(root)).toHaveLength(1);
    expect(readFileSync(join(thread.cwd, 'output.md'), 'utf8')).toBe('# Saved output');
  });

  it('keeps a fork in its own directory with a copy of the current files', async () => {
    const source = await create();
    await send(source.id);
    writeFileSync(join(source.cwd, 'output.md'), 'source');
    const operation = await service.forkThread(source.id, { clientOperationId: operationId() });
    const fork = await service.getThread((operation.result as { threadId: string }).threadId);
    expect(fork).toMatchObject({ projectId: null, forkedFromId: source.id });
    expect(fork.cwd).not.toBe(source.cwd);
    expect(readFileSync(join(fork.cwd, 'output.md'), 'utf8')).toBe('source');
    writeFileSync(join(fork.cwd, 'output.md'), 'fork');
    expect(readFileSync(join(source.cwd, 'output.md'), 'utf8')).toBe('source');
  });

  it('does not let siblings, symlinks, or a parent project adopt another session directory', async () => {
    const [first, second] = await Promise.all([create(), create()]);
    writeFileSync(join(second.cwd, 'private.md'), 'second session');
    symlinkSync(join(second.cwd, 'private.md'), join(first.cwd, 'shortcut.md'));
    for (const path of [join(second.cwd, 'private.md'), 'shortcut.md'])
      await expect(service.getThreadMarkdown(first.id, path)).rejects.toMatchObject({
        code: 'MARKDOWN_OUTSIDE_PROJECT',
      });
    const parent = service.addProject({ path: db.directory, name: 'Parent' });
    expect(() => service.addProject({ path: root })).toThrow('不能归入项目');
    expect((await service.listThreads(parent.id)).data).toEqual([]);
    codex.threads.set('foreign', threadView('foreign', first.cwd));
    await expect(service.getThread('foreign')).rejects.toMatchObject({ code: 'PROJECT_OWNERSHIP' });
    const projectThread = await service.createThread(parent.id, {
      clientOperationId: operationId(),
    });
    await expect(
      service.getThreadMarkdown(
        (projectThread.result as { threadId: string }).threadId,
        join(second.cwd, 'private.md'),
      ),
    ).rejects.toMatchObject({ code: 'MARKDOWN_OUTSIDE_PROJECT' });
  });

  it('rejects a changed workspace directory and a thread reporting a sibling cwd', async () => {
    const [first, second] = await Promise.all([create(), create()]);
    const registry = new WorkspaceRegistry(db.db.database, projects, root);
    expect(() => registry.assertOwnership(null, second.cwd, first.id)).toThrow('不一致');
    renameSync(first.cwd, `${first.cwd}-saved`);
    symlinkSync(second.cwd, first.cwd);
    await expect(service.getThread(first.id)).rejects.toMatchObject({
      code: 'WORKSPACE_UNAVAILABLE',
    });
  });

  it('authorizes older history pages against the same saved workspace', async () => {
    const [first, second] = await Promise.all([create(), create()]);
    await send(first.id);
    const readPage = vi.fn(async () => ({
      ...(await codex.readThread(first.id)),
      historyCursor: null,
    }));
    Object.assign(codex, { readThreadPage: readPage });
    expect((await service.getThreadHistory(first.id, 'older')).projectId).toBeNull();
    readPage.mockResolvedValueOnce({
      ...(await codex.readThread(first.id)),
      cwd: second.cwd,
      historyCursor: null,
    });
    await expect(service.getThreadHistory(first.id, 'older')).rejects.toMatchObject({
      code: 'PROJECT_OWNERSHIP',
    });
  });

  it('returns a definite allocation error before dispatch and permits a fresh retry', async () => {
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o500);
    const id = operationId();
    try {
      await expect(create(id)).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
      expect(service.getOperation(id).status).toBe('failed');
      expect(codex.creates).toBe(0);
    } finally {
      chmodSync(root, 0o700);
    }
    expect((await create()).projectId).toBeNull();
  });

  it('keeps an uncertain creation as one intent and never automatically dispatches it again', async () => {
    const id = operationId();
    const nativeCreate = codex.createThread.bind(codex);
    vi.spyOn(codex, 'createThread').mockImplementationOnce(async (cwd) => {
      await nativeCreate(cwd);
      throw new Error('lost receipt');
    });
    await expect(create(id)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect((await service.createThread(null, { clientOperationId: id })).status).toBe('unknown');
    expect(codex.creates).toBe(1);
    expect(readdirSync(root)).toHaveLength(1);
    // Recovery reads metadata from that one allocated directory; it never replays create.
    await service.listThreads(null);
    expect(service.getOperation(id)).toMatchObject({
      status: 'acknowledged',
      result: { threadId: 'thread-1' },
    });
    expect(codex.creates).toBe(1);
  });

  it('exposes strict same-origin endpoints without accepting a client directory', async () => {
    const config = parseConfig(
      { publicOrigin: ['http://127.0.0.1:8787'], dataDir: db.directory },
      join(db.directory, 'config.json'),
    );
    const app = createApp({ config, service, staticDir: db.directory });
    const post = (body: object, origin = 'http://127.0.0.1:8787') =>
      app.request('http://127.0.0.1:8787/api/unassigned/threads', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ clientOperationId: operationId(), cwd: db.directory })).status).toBe(400);
    expect((await post({ clientOperationId: operationId() }, 'https://other.example')).status).toBe(
      403,
    );
    expect((await post({ clientOperationId: operationId() })).status).toBe(200);
    expect(service.listProjects()).toEqual([]);
    expect(realpathSync(root)).toContain('workspaces');
  });
});
