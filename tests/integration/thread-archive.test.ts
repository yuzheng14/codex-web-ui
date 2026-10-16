import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { harness, operationId, threadView, deferred } from './domain-helpers.js';
import { GatewayService } from '../../src/server/service.js';
import { OperationStore } from '../../src/server/db/operations.js';
import { openDatabase } from '../../src/server/db/index.js';
import { migrateDatabase } from '../../src/server/db/migrate.js';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import type { ServerMessage, ThreadPage } from '../../src/shared/types.js';

const resources: ReturnType<typeof harness>[] = [];
function setup() {
  const resource = harness();
  resources.push(resource);
  return resource;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) resource.close();
});
async function create(service: GatewayService) {
  const result = await service.createThread('project', { clientOperationId: operationId() });
  return (result.result as { threadId: string }).threadId;
}

it('archives an active thread without touching execution, identity, history or approval controls', async () => {
  const { service, codex, store } = setup();
  const id = await create(service);
  await service.startTurn(id, { clientOperationId: operationId(), text: 'keep this history' });
  const before = await service.getThread(id);
  const marker = store.activeForThread(id);
  const events: ServerMessage[] = [];
  service.subscribeOverview((event) => events.push(event));
  const details: ServerMessage[] = [];
  await service.subscribe(id, undefined, (event) => details.push(event));
  await service.setThreadArchived(id, true);
  expect(await service.getThread(id)).toEqual({ ...before, archived: true });
  expect(store.activeForThread(id)).toEqual(marker);
  expect((await service.listThreads('project')).data).toEqual([]);
  expect((await service.listThreadSummaries('project', undefined, true)).data).toMatchObject([
    { id, archived: true, status: 'running' },
  ]);
  expect(events.at(-1)).toMatchObject({ kind: 'threadSummary', payload: { id, archived: true } });
  expect(details.at(-1)).toMatchObject({ kind: 'thread', payload: { id, archived: true } });
  expect(codex.interrupts).toBe(0);
  expect(codex.resumes).toBe(0);
  codex.complete(id, 'turn-1');
  expect(events.at(-1)).toMatchObject({ payload: { archived: true, status: 'completed' } });
  await service.setThreadArchived(id, false);
  await service.setThreadArchived(id, false);
  expect((await service.listThreads('project')).data[0]).toMatchObject({ id, archived: false });
  expect((await service.listThreads('project', undefined, true)).data).toEqual([]);
  await service.startTurn(id, { clientOperationId: operationId(), text: 'continue same identity' });
  expect((await service.getThread(id)).turns).toHaveLength(2);
});

it('persists through a reopened database and service, and metadata refresh never clears the archive', async () => {
  const { service, codex, projects, filename, db } = setup();
  const id = await create(service);
  await service.startTurn(id, { clientOperationId: operationId(), text: 'saved' });
  codex.complete(id, 'turn-1');
  await service.setThreadArchived(id, true);
  await service.shutdown();
  db.close();
  codex.reset();
  const reopened = openDatabase(filename);
  try {
    migrateDatabase(reopened.database);
    const recovered = new GatewayService({
      codex,
      projects,
      store: new OperationStore(reopened.database),
    });
    expect((await recovered.listThreads('project')).data).toEqual([]);
    const archived = await recovered.listThreads('project', undefined, true);
    expect(archived.data[0]).toMatchObject({
      id,
      archived: true,
      turns: [{ items: [{ text: 'saved' }] }],
    });
    await recovered.setThreadArchived(id, false);
    expect(new OperationStore(reopened.database).getThreadLink(id)?.archived).toBe(false);
    await recovered.shutdown();
  } finally {
    reopened.close();
  }
});

it('lists archived sessions independently of the upstream first page, with stable pagination', async () => {
  const { service, codex, project } = setup();
  for (let i = 0; i < 32; i++) {
    const id = `archived-${String(i).padStart(2, '0')}`;
    codex.threads.set(id, threadView(id, project));
    await service.setThreadArchived(id, true);
  }
  const list = vi.spyOn(codex, 'listThreads').mockResolvedValue({ data: [], nextCursor: null });
  const first = await service.listThreadSummaries('project', undefined, true);
  const second = await service.listThreadSummaries('project', first.nextCursor!, true);
  expect(first.data).toHaveLength(30);
  expect(second.data).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.data, ...second.data].map((thread) => thread.id)).size).toBe(32);
  expect(list).not.toHaveBeenCalled();
});

it('does not publish or change persisted visibility when saving fails', async () => {
  const { service, store } = setup();
  const id = await create(service);
  const listener = vi.fn();
  service.subscribeOverview(listener);
  vi.spyOn(store, 'setThreadArchived').mockImplementation(() => {
    throw new Error('disk full');
  });
  await expect(service.setThreadArchived(id, true)).rejects.toMatchObject({
    code: 'ARCHIVE_SAVE_FAILED',
  });
  expect((await service.getThread(id)).archived).toBe(false);
  expect(listener).not.toHaveBeenCalled();
});

it('uses the current archive state after an older upstream list read completes', async () => {
  const { service, codex, project } = setup();
  const id = await create(service);
  const gate = deferred<ThreadPage>();
  vi.spyOn(codex, 'listThreads').mockReturnValue(gate.promise);
  const read = service.listThreads('project');
  await service.setThreadArchived(id, true);
  gate.resolve({ data: [threadView(id, project)], nextCursor: 'next' });
  expect(await read).toEqual({ data: [], nextCursor: 'next' });
});

it('validates the HTTP boundary and rejects foreign origins and out-of-project history', async () => {
  const { service, codex, directory, project } = setup();
  const config = parseConfig(
    {
      dataDir: join(directory, 'data'),
      projects: [{ id: 'project', name: 'Test', path: project }],
    },
    join(directory, 'config.json'),
  );
  const app = createApp({ config, service, staticDir: directory });
  const id = await create(service);
  const post = (body: unknown, origin = config.publicOrigin[0]) =>
    app.request(`http://127.0.0.1:8787/api/threads/${id}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin! },
      body: JSON.stringify(body),
    });
  for (const body of [{}, { archived: 'true' }, { archived: true, cwd: '/tmp' }])
    expect((await post(body)).status).toBe(400);
  expect((await post({ archived: true }, 'https://foreign.invalid')).status).toBe(403);
  expect((await post({ archived: true })).status).toBe(200);
  const list = await app.request(
    'http://127.0.0.1:8787/api/projects/project/threads?archived=true',
  );
  expect(await list.json()).toMatchObject({ data: [{ id, archived: true }] });
  expect(
    (await app.request('http://127.0.0.1:8787/api/projects/project/threads?archived=maybe')).status,
  ).toBe(400);
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  codex.threads.set('outside', threadView('outside', outside));
  await expect(service.setThreadArchived('outside', true)).rejects.toMatchObject({
    code: 'PROJECT_OWNERSHIP',
  });
});
