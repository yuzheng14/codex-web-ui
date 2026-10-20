import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/server/config.js';
import { openDatabase } from '../../src/server/db/index.js';
import { migrateDatabase } from '../../src/server/db/migrate.js';
import { OperationStore } from '../../src/server/db/operations.js';
import { createApp } from '../../src/server/http.js';
import { ProjectRegistry, type ProjectConfig } from '../../src/server/projects.js';
import { GatewayService } from '../../src/server/service.js';
import type { Project, ThreadView } from '../../src/shared/types.js';
import { deferred, DomainCodex, operationId, threadView } from './domain-helpers.js';
import { gitCloneFixture } from '../helpers/git-clone.js';

const cleanups: (() => void)[] = [];
const origin = 'http://127.0.0.1:8787';
function setup(configure: (directory: string) => ProjectConfig[] = () => []) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-project-management-'));
  const filename = join(directory, 'data', 'app.sqlite');
  const web = join(directory, 'web');
  mkdirSync(web);
  const initial = configure(directory);
  let db = openDatabase(filename);
  migrateDatabase(db.database);
  let store = new OperationStore(db.database);
  const codex = new DomainCodex();
  let projects = new ProjectRegistry(initial, db.database);
  let service = new GatewayService({ store, projects, codex });
  function appFor(current: GatewayService, configured: ProjectConfig[]) {
    const config = parseConfig({ projects: configured }, join(directory, 'config.json'));
    return createApp({ config, service: current, staticDir: web });
  }
  let app = appFor(service, initial);
  cleanups.push(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    codex,
    get service() {
      return service;
    },
    get projects() {
      return projects;
    },
    get store() {
      return store;
    },
    request: (path: string) => app.request(`${origin}${path}`),
    post: (path: string, body: unknown, browserOrigin = origin) =>
      app.request(`${origin}${path}`, {
        method: 'POST',
        headers: { origin: browserOrigin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    async restart(configured = initial) {
      await service.shutdown();
      db.close();
      db = openDatabase(filename);
      migrateDatabase(db.database);
      store = new OperationStore(db.database);
      projects = new ProjectRegistry(configured, db.database);
      codex.ready = true;
      service = new GatewayService({ store, projects, codex });
      app = appFor(service, configured);
    },
  };
}
type Harness = ReturnType<typeof setup>;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function add(harness: Harness, path: string, name?: string): Promise<Project> {
  const response = await harness.post('/api/projects', { path, ...(name ? { name } : {}) });
  expect(response.status).toBe(200);
  return response.json() as Promise<Project>;
}
async function create(harness: Harness, projectId: string) {
  const operation = await harness.service.createThread(projectId, {
    clientOperationId: operationId(),
  });
  return (operation.result as { threadId: string }).threadId;
}
async function createHistory(harness: Harness, projectId: string) {
  const id = await create(harness, projectId);
  const started = await harness.service.startTurn(id, {
    clientOperationId: operationId(),
    text: 'Saved project history',
  });
  harness.codex.complete(id, (started.result as { turnId: string }).turnId);
  return id;
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}
function seed(directory: string): ProjectConfig[] {
  const path = join(directory, 'project');
  mkdirSync(path);
  return [{ id: 'configured', name: 'Configured project', path }];
}

describe('persistent project management', () => {
  it('starts without configured projects and persists add, rename, remove and restore across restarts', async () => {
    expect(parseConfig({}, '/tmp/config.json').projects).toEqual([]);
    const harness = setup();
    expect(await (await harness.request('/api/projects')).json()).toEqual({ data: [] });
    const path = join(harness.directory, '目录 with spaces');
    mkdirSync(path);
    writeFileSync(join(path, 'keep.txt'), 'user work must survive removal');
    const project = await add(harness, path);
    expect(project).toMatchObject({
      name: basename(path),
      canonicalRoot: realpathSync(path),
      available: true,
    });
    const threadId = await create(harness, project.id);
    const rename = await harness.post(`/api/projects/${project.id}/rename`, { name: '  新名称  ' });
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({ id: project.id, name: '新名称' });
    await harness.restart();
    expect(harness.service.listProjects()).toEqual([
      expect.objectContaining({ id: project.id, name: '新名称' }),
    ]);
    expect(await harness.service.getThread(threadId)).toMatchObject({ projectId: project.id });
    expect(await (await harness.post(`/api/projects/${project.id}/remove`, {})).json()).toEqual({
      removed: true,
    });
    expect(harness.store.getThreadLink(threadId)?.projectId).toBe(project.id);
    expect(readFileSync(join(path, 'keep.txt'), 'utf8')).toBe('user work must survive removal');
    await harness.restart();
    expect(harness.service.listProjects()).toEqual([]);
    await expect(harness.service.getThread(threadId)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    const restored = await add(harness, path, 'Restored');
    expect(restored).toMatchObject({ id: project.id, name: 'Restored' });
    expect(await harness.service.getThread(threadId)).toMatchObject({
      id: threadId,
      projectId: project.id,
    });
  });

  it('imports new config entries but preserves UI names and tombstones for existing IDs', async () => {
    const harness = setup(seed);
    const path = harness.projects.get('configured').rootPath;
    await harness.post('/api/projects/configured/rename', { name: 'UI name' });
    const second = join(harness.directory, 'second');
    mkdirSync(second);
    const configured = [
      { id: 'configured', name: 'Stale config name', path },
      { id: 'new-config', name: 'New configuration', path: second },
    ];
    await harness.restart(configured);
    expect(harness.service.listProjects()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'configured', name: 'UI name' }),
        expect.objectContaining({ id: 'new-config', name: 'New configuration' }),
      ]),
    );
    await harness.post('/api/projects/configured/remove', {});
    await harness.restart(configured);
    expect(harness.service.listProjects().map((project) => project.id)).toEqual(['new-config']);
    expect(await add(harness, path)).toMatchObject({ id: 'configured' });
    await expect(
      harness.restart([{ id: 'configured', name: 'Reassigned', path: second }]),
    ).rejects.toMatchObject({ code: 'PROJECT_ID_CONFLICT' });
  });

  it('canonicalizes directories and rejects duplicate aliases, files, absent and relative paths', async () => {
    const harness = setup();
    const path = join(harness.directory, 'actual');
    mkdirSync(path);
    const alias = join(harness.directory, 'alias');
    symlinkSync(path, alias, 'dir');
    const project = await add(harness, alias);
    expect(project.canonicalRoot).toBe(realpathSync(path));
    for (const duplicate of [path, join(path, '.'), alias]) {
      const response = await harness.post('/api/projects', { path: duplicate });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'PROJECT_EXISTS', details: { projectId: project.id } },
      });
    }
    const file = join(harness.directory, 'file');
    writeFileSync(file, 'not a directory');
    for (const invalid of [file, join(harness.directory, 'missing')])
      await expectError(
        await harness.post('/api/projects', { path: invalid }),
        409,
        'PROJECT_UNAVAILABLE',
      );
    await expectError(
      await harness.post('/api/projects', { path: '../relative' }),
      400,
      'INVALID_PROJECT_PATH',
    );
    expect(harness.service.listProjects()).toHaveLength(1);
  });

  it('does not follow a registered symlink into a different directory and permits removing unavailable registrations', async () => {
    const harness = setup((directory) => {
      const original = join(directory, 'original');
      const alias = join(directory, 'alias');
      mkdirSync(original);
      symlinkSync(original, alias, 'dir');
      return [{ id: 'symlink', name: 'Legacy symlink', path: alias }];
    });
    const replacement = join(harness.directory, 'replacement');
    mkdirSync(replacement);
    const alias = join(harness.directory, 'alias');
    const project = harness.projects.get('symlink');
    rmSync(alias);
    symlinkSync(replacement, alias, 'dir');
    expect(harness.service.listProjects()).toEqual([
      expect.objectContaining({ id: project.id, available: false }),
    ]);
    await expectError(
      await harness.post(`/api/projects/${project.id}/threads`, {
        clientOperationId: operationId(),
      }),
      409,
      'PROJECT_UNAVAILABLE',
    );
    expect(harness.codex.creates).toBe(0);
    expect((await harness.post(`/api/projects/${project.id}/remove`, {})).status).toBe(200);
    const missing = join(harness.directory, 'vanishing');
    mkdirSync(missing);
    const removedDirectory = await add(harness, missing);
    rmSync(missing, { recursive: true });
    expect(
      (
        await harness.post(`/api/projects/${removedDirectory.id}/rename`, {
          name: 'Missing project',
        })
      ).status,
    ).toBe(200);
    expect((await harness.post(`/api/projects/${removedDirectory.id}/remove`, {})).status).toBe(
      200,
    );
  });
});

describe('project mutation security and ownership', () => {
  it.each(['detail', 'subscription'] as const)(
    'rejects a %s read when the project is removed during metadata refresh',
    async (entry) => {
      const harness = setup(seed);
      const threadId = await create(harness, 'configured');
      const snapshot = structuredClone(harness.codex.threads.get(threadId)!);
      const metadata = deferred<ThreadView>();
      const reading = deferred<void>();
      vi.spyOn(harness.codex, 'readThreadMetadata').mockImplementationOnce(() => {
        reading.resolve();
        return metadata.promise;
      });
      const receive = vi.fn();
      const pending =
        entry === 'detail'
          ? harness.service.getThread(threadId)
          : harness.service.subscribe(threadId, undefined, receive);
      await reading.promise;
      expect(harness.service.removeProject('configured')).toEqual({ removed: true });
      metadata.resolve(snapshot);
      await expect(pending).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
      expect(receive).not.toHaveBeenCalled();
      expect(harness.store.getThreadLink(threadId)?.projectId).toBe('configured');
    },
  );

  it('requires same-origin JSON mutations and rejects undeclared path and cwd inputs', async () => {
    const harness = setup(seed);
    const path = join(harness.directory, 'new-project');
    mkdirSync(path);
    const mutations: [string, unknown][] = [
      ['/api/projects', { path }],
      ['/api/projects/configured/rename', { name: 'Changed' }],
      ['/api/projects/configured/remove', {}],
    ];
    for (const [endpoint, body] of mutations)
      await expectError(
        await harness.post(endpoint, body, 'https://attacker.invalid'),
        403,
        'INVALID_ORIGIN',
      );
    for (const [endpoint, body] of [
      ['/api/projects', { path, cwd: path }],
      ['/api/projects/configured/rename', { name: 'Changed', path }],
      ['/api/projects/configured/remove', { deleteFiles: true }],
      ['/api/projects/configured/threads', { clientOperationId: operationId(), cwd: path }],
    ] as const)
      await expectError(await harness.post(endpoint, body), 400, 'VALIDATION_FAILED');
    expect(harness.service.listProjects()).toEqual([
      expect.objectContaining({ id: 'configured', name: 'Configured project' }),
    ]);
    expect(harness.codex.creates).toBe(0);
  });

  it('keeps linked history attached to its original project across parent listings, removal and restore', async () => {
    const harness = setup();
    const parent = join(harness.directory, 'parent');
    const nested = join(parent, 'nested');
    mkdirSync(nested, { recursive: true });
    const parentProject = await add(harness, parent);
    const nestedProject = await add(harness, nested);
    const threadId = await createHistory(harness, nestedProject.id);
    expect((await harness.service.listThreads(parentProject.id)).data).toEqual([]);
    expect(harness.store.getThreadLink(threadId)?.projectId).toBe(nestedProject.id);
    expect(
      (await harness.service.listThreads(nestedProject.id)).data.map((thread) => thread.id),
    ).toContain(threadId);
    await harness.post(`/api/projects/${nestedProject.id}/remove`, {});
    await harness.restart();
    expect((await harness.service.listThreads(parentProject.id)).data).toEqual([]);
    expect(harness.store.getThreadLink(threadId)?.projectId).toBe(nestedProject.id);
    await expect(
      harness.service.forkThread(threadId, { clientOperationId: operationId() }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(harness.codex.forks).toBe(0);
    expect(await add(harness, nested)).toMatchObject({ id: nestedProject.id });
    expect(
      (await harness.service.listThreads(nestedProject.id)).data.map((thread) => thread.id),
    ).toContain(threadId);
  });

  it('does not expose threads through symlinks escaping a registered directory', async () => {
    const harness = setup(seed);
    const project = harness.projects.get('configured');
    const outside = join(harness.directory, 'outside');
    mkdirSync(outside);
    const escape = join(project.rootPath, 'escape');
    symlinkSync(outside, escape, 'dir');
    harness.codex.threads.set('escaped', threadView('escaped', escape));
    expect((await harness.service.listThreads(project.id)).data).toEqual([]);
    await expect(harness.service.getThread('escaped')).rejects.toMatchObject({
      code: 'PROJECT_OWNERSHIP',
    });
    expect(harness.store.getThreadLink('escaped')).toBeUndefined();
  });
});

describe('project removal during task activity', () => {
  it('allows parallel threads in one project but blocks removal until every execution ends', async () => {
    const harness = setup(seed);
    const first = await create(harness, 'configured');
    const second = await create(harness, 'configured');
    const results = await Promise.all([
      harness.service.startTurn(first, { clientOperationId: operationId(), text: 'first task' }),
      harness.service.startTurn(second, { clientOperationId: operationId(), text: 'second task' }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['acknowledged', 'acknowledged']);
    expect(harness.store.activeMarkers()).toHaveLength(2);
    await expectError(
      await harness.post('/api/projects/configured/remove', {}),
      409,
      'PROJECT_BUSY',
    );
    harness.codex.complete(first, 'turn-1');
    expect(harness.store.activeForThread(first)).toBeUndefined();
    expect(harness.store.activeForThread(second)?.state).toBe('active');
    await expectError(
      await harness.post('/api/projects/configured/remove', {}),
      409,
      'PROJECT_BUSY',
    );
    await harness.restart();
    expect(harness.store.activeForThread(second)?.state).toBe('unknown');
    await expectError(
      await harness.post('/api/projects/configured/remove', {}),
      409,
      'PROJECT_BUSY',
    );
    harness.codex.complete(second, 'turn-2');
    await harness.service.getThread(second);
    expect(harness.store.activeMarkers()).toEqual([]);
    expect((await harness.post('/api/projects/configured/remove', {})).status).toBe(200);
  });

  it('allows removal of an idle project when another project in the same directory is active', async () => {
    const harness = setup((directory) => {
      const path = join(directory, 'project');
      mkdirSync(path);
      return [
        { id: 'busy', name: 'Busy project', path },
        { id: 'idle', name: 'Idle project', path },
      ];
    });
    const busy = await create(harness, 'busy');
    const idle = await create(harness, 'idle');
    await harness.service.startTurn(busy, {
      clientOperationId: operationId(),
      text: 'active task',
    });
    const marker = harness.store.activeForThread(busy);
    expect((await harness.post('/api/projects/idle/remove', {})).status).toBe(200);
    expect(harness.store.activeForThread(busy)).toEqual(marker);
    expect(harness.store.getThreadLink(idle)?.projectId).toBe('idle');
    await expectError(await harness.post('/api/projects/busy/remove', {}), 409, 'PROJECT_BUSY');
    harness.codex.complete(busy, 'turn-1');
    expect((await harness.post('/api/projects/busy/remove', {})).status).toBe(200);
  });

  it('blocks active and recovered unknown executions until the original execution is resolved', async () => {
    const harness = setup(seed);
    const id = await create(harness, 'configured');
    await harness.service.startTurn(id, { clientOperationId: operationId(), text: 'work' });
    await expectError(
      await harness.post('/api/projects/configured/remove', {}),
      409,
      'PROJECT_BUSY',
    );
    expect(
      (await harness.post('/api/projects/configured/rename', { name: 'Busy renamed' })).status,
    ).toBe(200);
    await harness.restart();
    expect(harness.store.activeForThread(id)?.state).toBe('unknown');
    await expectError(
      await harness.post('/api/projects/configured/remove', {}),
      409,
      'PROJECT_BUSY',
    );
    harness.codex.complete(id, 'turn-1');
    await harness.service.getThread(id);
    expect((await harness.post('/api/projects/configured/remove', {})).status).toBe(200);
  });

  it('blocks removal while create has dispatched without an upstream thread ID', async () => {
    const harness = setup(seed);
    const gate = deferred<ThreadView>();
    vi.spyOn(harness.codex, 'createThread').mockReturnValueOnce(gate.promise);
    const pending = harness.service.createThread('configured', {
      clientOperationId: operationId(),
    });
    await expectError(
      await harness.post('/api/projects/configured/remove', {}),
      409,
      'PROJECT_BUSY',
    );
    const thread = threadView('created', harness.projects.get('configured').canonicalRoot);
    harness.codex.threads.set(thread.id, thread);
    gate.resolve(thread);
    expect(await pending).toMatchObject({ status: 'acknowledged' });
    expect((await harness.post('/api/projects/configured/remove', {})).status).toBe(200);
  });

  it.each(['resume', 'fork'] as const)(
    'blocks removal while %s is awaiting an upstream result',
    async (operation) => {
      const harness = setup(seed);
      const thread = threadView('history', harness.projects.get('configured').canonicalRoot);
      harness.codex.threads.set(thread.id, thread);
      await harness.service.getThread(thread.id);
      const gate = deferred<ThreadView>();
      const started = deferred<void>();
      vi.spyOn(
        harness.codex,
        operation === 'resume' ? 'resumeThread' : 'forkThread',
      ).mockImplementationOnce(() => {
        started.resolve();
        return gate.promise;
      });
      const input = { clientOperationId: operationId(), confirmExternalStopped: true };
      const pending =
        operation === 'resume'
          ? harness.service.resumeThread(thread.id, input)
          : harness.service.forkThread(thread.id, input);
      await started.promise;
      await expectError(
        await harness.post('/api/projects/configured/remove', {}),
        409,
        'PROJECT_BUSY',
      );
      const returned = { ...thread, id: operation === 'fork' ? 'forked' : thread.id };
      harness.codex.threads.set(returned.id, returned);
      gate.resolve(returned);
      expect(await pending).toMatchObject({ status: 'acknowledged' });
      expect((await harness.post('/api/projects/configured/remove', {})).status).toBe(200);
    },
  );
});

describe('project identity and removal recovery regressions', () => {
  it('keeps legacy alias IDs and restores an unavailable config registration under its original ID', async () => {
    const harness = setup((directory) => {
      const actual = join(directory, 'actual');
      const alias = join(directory, 'alias');
      mkdirSync(actual);
      symlinkSync(actual, alias, 'dir');
      return [
        { id: 'original', name: 'Original', path: actual },
        { id: 'legacy-alias', name: 'Alias', path: alias },
        { id: 'unavailable', name: 'Unavailable', path: join(directory, 'later') },
      ];
    });
    const threadId = await createHistory(harness, 'legacy-alias');
    expect(harness.store.getThreadLink(threadId)?.projectId).toBe('legacy-alias');
    expect((await harness.service.listThreads('original')).data).toEqual([]);
    expect(
      (await harness.service.listThreads('legacy-alias')).data.map((thread) => thread.id),
    ).toContain(threadId);
    expect((await harness.post('/api/projects/unavailable/remove', {})).status).toBe(200);
    await harness.restart();
    mkdirSync(join(harness.directory, 'later'));
    expect(await add(harness, join(harness.directory, 'later'))).toMatchObject({
      id: 'unavailable',
      name: 'Unavailable',
    });
    expect(harness.store.getThreadLink(threadId)?.projectId).toBe('legacy-alias');
  });

  it.each(['original', 'legacy-alias'])(
    'restores removed legacy identity %s while its same-root alias stays active',
    async (removedId) => {
      const harness = setup((directory) => {
        const actual = join(directory, 'actual');
        const alias = join(directory, 'alias');
        mkdirSync(actual);
        symlinkSync(actual, alias, 'dir');
        return [
          { id: 'original', name: 'Original', path: actual },
          { id: 'legacy-alias', name: 'Alias', path: alias },
        ];
      });
      const survivingId = removedId === 'original' ? 'legacy-alias' : 'original';
      const removedThread = await createHistory(harness, removedId);
      const survivingThread = await createHistory(harness, survivingId);
      expect((await harness.post(`/api/projects/${removedId}/remove`, {})).status).toBe(200);
      await harness.restart();
      const path = join(harness.directory, 'actual');
      harness.codex.threads.set('unlinked-history', threadView('unlinked-history', path));
      expect(
        (await harness.service.listThreads(survivingId)).data.map((thread) => thread.id),
      ).toEqual(expect.arrayContaining([survivingThread, 'unlinked-history']));
      expect(harness.store.getThreadLink('unlinked-history')?.projectId).toBe(survivingId);
      await expect(harness.service.getThread(removedThread)).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
      });
      expect(await add(harness, path)).toMatchObject({ id: removedId });
      expect(await harness.service.getThread(removedThread)).toMatchObject({
        projectId: removedId,
      });
      expect(harness.store.getThreadLink('unlinked-history')?.projectId).toBe(survivingId);
      expect(harness.service.listProjects().map((project) => project.id)).toEqual([
        'original',
        'legacy-alias',
      ]);
      await expectError(await harness.post('/api/projects', { path }), 409, 'PROJECT_EXISTS');
    },
  );

  it('assigns unlinked nested history to its closest project even when the parent is listed first', async () => {
    const harness = setup();
    const parent = join(harness.directory, 'parent');
    const nested = join(parent, 'nested');
    mkdirSync(nested, { recursive: true });
    const parentProject = await add(harness, parent);
    const nestedProject = await add(harness, nested);
    harness.codex.threads.set('nested-history', threadView('nested-history', nested));
    expect((await harness.service.listThreads(parentProject.id)).data).toEqual([]);
    expect((await harness.service.listThreads(nestedProject.id)).data).toEqual([
      expect.objectContaining({ id: 'nested-history', projectId: nestedProject.id }),
    ]);
    expect(harness.store.getThreadLink('nested-history')?.projectId).toBe(nestedProject.id);
  });

  it('reserves removed nested roots so undiscovered history cannot migrate to the parent', async () => {
    const harness = setup();
    const parent = join(harness.directory, 'parent');
    const nested = join(parent, 'nested');
    mkdirSync(nested, { recursive: true });
    const parentProject = await add(harness, parent);
    const nestedProject = await add(harness, nested);
    harness.codex.threads.set('unseen-history', threadView('unseen-history', nested));
    expect((await harness.post(`/api/projects/${nestedProject.id}/remove`, {})).status).toBe(200);
    await harness.restart();
    expect((await harness.service.listThreads(parentProject.id)).data).toEqual([]);
    expect(harness.store.getThreadLink('unseen-history')).toBeUndefined();
    await expect(harness.service.getThread('unseen-history')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    expect(await add(harness, nested)).toMatchObject({ id: nestedProject.id });
    expect((await harness.service.listThreads(nestedProject.id)).data).toEqual([
      expect.objectContaining({ id: 'unseen-history', projectId: nestedProject.id }),
    ]);
  });

  it('rejects reconciliation of a live metadata request so it cannot bypass removal protection', async () => {
    const harness = setup(seed);
    const gate = deferred<ThreadView>();
    vi.spyOn(harness.codex, 'createThread').mockReturnValueOnce(gate.promise);
    const clientOperationId = operationId();
    const pending = harness.service.createThread('configured', { clientOperationId });
    await expect(
      harness.service.reconcileOperation(clientOperationId, {
        clientOperationId: operationId(),
        confirmEnded: true,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_BUSY' });
    expect(harness.service.getOperation(clientOperationId)).toMatchObject({
      status: 'dispatching',
    });
    await expectError(
      await harness.post('/api/projects/configured/remove', {}),
      409,
      'PROJECT_BUSY',
    );
    gate.resolve(threadView('created', harness.projects.get('configured').canonicalRoot));
    expect(await pending).toMatchObject({ status: 'acknowledged' });
  });

  it.each(['resume', 'fork'] as const)(
    'blocks removal while a linked %s is still reading source history',
    async (operation) => {
      const harness = setup(seed);
      const thread = threadView('history', harness.projects.get('configured').canonicalRoot);
      harness.codex.threads.set(thread.id, thread);
      await harness.service.getThread(thread.id);
      await harness.restart();
      const gate = deferred<ThreadView>();
      const reading = deferred<void>();
      vi.spyOn(harness.codex, 'readThread').mockImplementationOnce(() => {
        reading.resolve();
        return gate.promise;
      });
      const clientOperationId = operationId();
      const pending =
        operation === 'resume'
          ? harness.service.resumeThread(thread.id, {
              clientOperationId,
              confirmExternalStopped: true,
            })
          : harness.service.forkThread(thread.id, { clientOperationId });
      await reading.promise;
      expect(harness.service.getOperation(clientOperationId)).toMatchObject({ status: 'accepted' });
      expect(harness.codex.resumes + harness.codex.forks).toBe(0);
      await expectError(
        await harness.post('/api/projects/configured/remove', {}),
        409,
        'PROJECT_BUSY',
      );
      gate.resolve(thread);
      expect(await pending).toMatchObject({ status: 'acknowledged' });
      expect((await harness.post('/api/projects/configured/remove', {})).status).toBe(200);
    },
  );

  it.each(['create', 'resume', 'fork'] as const)(
    'persists uncertain %s outcomes and requires reconciliation before removal',
    async (operation) => {
      const harness = setup(seed);
      const thread = threadView('history', harness.projects.get('configured').canonicalRoot);
      harness.codex.threads.set(thread.id, thread);
      await harness.service.getThread(thread.id);
      const method =
        operation === 'create'
          ? 'createThread'
          : operation === 'resume'
            ? 'resumeThread'
            : 'forkThread';
      vi.spyOn(harness.codex, method).mockRejectedValueOnce(
        new Error('connection lost after dispatch'),
      );
      const clientOperationId = operationId();
      const pending =
        operation === 'create'
          ? harness.service.createThread('configured', { clientOperationId })
          : operation === 'resume'
            ? harness.service.resumeThread(thread.id, {
                clientOperationId,
                confirmExternalStopped: true,
              })
            : harness.service.forkThread(thread.id, { clientOperationId });
      await expect(pending).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
      expect(harness.store.marker(clientOperationId)).toBeUndefined();
      await harness.restart();
      rmSync(join(harness.directory, 'project'), { recursive: true });
      await expectError(
        await harness.post('/api/projects/configured/remove', {}),
        409,
        'PROJECT_BUSY',
      );
      expect(harness.service.getOperation(clientOperationId)).toMatchObject({ status: 'unknown' });
      expect(
        await harness.service.reconcileOperation(clientOperationId, {
          clientOperationId: operationId(),
          confirmEnded: true,
        }),
      ).toMatchObject({ status: 'acknowledged' });
      expect((await harness.post('/api/projects/configured/remove', {})).status).toBe(200);
    },
  );
});

describe('project clone HTTP lifecycle', () => {
  it('guards clone routes, blocks registration and upgrades during cloning, and supports cancellation', async () => {
    const h = setup();
    for (const [key, value] of Object.entries(gitCloneFixture(h.directory))) vi.stubEnv(key, value);
    const input = {
      clientOperationId: operationId(),
      repository: 'https://example.test/slow.git',
      path: join(h.directory, 'clone'),
    };
    await expectError(
      await h.post('/api/project-clones', input, 'https://evil.test'),
      403,
      'INVALID_ORIGIN',
    );
    await expectError(
      await h.post('/api/project-clones', { ...input, extra: true }),
      400,
      'VALIDATION_FAILED',
    );
    const started = await h.post('/api/project-clones', input);
    expect(started.status).toBe(202);
    expect((await (await h.post('/api/project-clones', input)).json()).id).toBe(
      input.clientOperationId,
    );
    expect(h.service.prepareUpdate()).toEqual({ ready: false, reason: '等待项目克隆完成或取消' });
    await expectError(
      await h.post('/api/projects', { path: input.path }),
      409,
      'CLONE_IN_PROGRESS',
    );
    expect((await h.post(`/api/project-clones/${input.clientOperationId}/cancel`, {})).status).toBe(
      200,
    );
    await vi.waitFor(() =>
      expect(h.service.projectClones.get(input.clientOperationId).status).toBe('cancelled'),
    );
    expect(
      await (await h.request(`/api/project-clones/${input.clientOperationId}`)).json(),
    ).toMatchObject({ status: 'cancelled' });
    expect(h.projects.list()).toEqual([]);
    expect(h.service.prepareUpdate()).toEqual({ ready: true });
    await expectError(
      await h.post('/api/project-clones', { ...input, clientOperationId: operationId() }),
      503,
      'UPDATE_MAINTENANCE',
    );
    await h.service.shutdown();
  });

  it('retries only registration after a successful clone and publishes projects', async () => {
    const h = setup();
    const fixture = gitCloneFixture(h.directory);
    for (const [key, value] of Object.entries(fixture)) vi.stubEnv(key, value);
    const add = vi.spyOn(h.projects, 'add').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    const publish = vi.spyOn(h.service.events, 'publishProjects');
    const id = operationId();
    expect(
      (
        await h.post('/api/project-clones', {
          clientOperationId: id,
          repository: 'git@example.test:org/repo.git',
          path: join(h.directory, 'clone'),
          name: 'Imported',
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(() =>
      expect(h.service.projectClones.get(id).status).toBe('registration-failed'),
    );
    expect(h.projects.list()).toEqual([]);
    const retry = await h.post(`/api/project-clones/${id}/register`, {});
    expect(await retry.json()).toMatchObject({
      status: 'completed',
      project: { name: 'Imported', available: true },
    });
    expect(add).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(readFileSync(fixture.COVRO_TEST_GIT_CALLS, 'utf8').trim().split('\n')).toHaveLength(1);
    await h.service.shutdown();
  });
});
