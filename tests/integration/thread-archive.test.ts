import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { harness, operationId, threadView, deferred } from './domain-helpers.js';
import { GatewayService } from '../../src/server/service.js';
import { OperationStore } from '../../src/server/db/operations.js';
import { openDatabase } from '../../src/server/db/index.js';
import { migrateDatabase } from '../../src/server/db/migrate.js';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import { AppError } from '../../src/shared/errors.js';
import { CodexError } from '../../src/codex/transport.js';
import type { ServerMessage, ThreadPage, ThreadView } from '../../src/shared/types.js';

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
const archiveInput = (archived = true) => ({ clientOperationId: operationId(), archived });

it('uses native archive and restore, preserves history and resumes the same identity', async () => {
  const { service, codex, store } = setup();
  const id = await create(service);
  await service.startTurn(id, { clientOperationId: operationId(), text: 'keep this history' });
  codex.complete(id, 'turn-1');
  const events: ServerMessage[] = [];
  service.subscribeOverview((event) => events.push(event));
  const input = archiveInput();
  const receipt = await service.setThreadArchived(id, input);
  expect(receipt).toMatchObject({
    status: 'acknowledged',
    result: { threadId: id, archived: true },
  });
  expect(await service.setThreadArchived(id, input)).toEqual(receipt);
  expect(codex.archives).toBe(1);
  expect(store.getThreadLink(id)?.managedEpoch).toBeNull();
  expect((await service.listThreads('project')).data).toEqual([]);
  expect((await service.listThreadSummaries('project', undefined, true)).data).toMatchObject([
    { id, archived: true, managed: false },
  ]);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'threadSummary',
        payload: expect.objectContaining({ id, archived: true }),
      }),
    ]),
  );
  await expect(
    service.resumeThread(id, { clientOperationId: operationId() }),
  ).rejects.toMatchObject({ code: 'THREAD_ARCHIVED' });
  await expect(
    service.startTurn(id, { clientOperationId: operationId(), text: 'blocked' }),
  ).rejects.toMatchObject({ code: 'THREAD_ARCHIVED' });
  await service.setThreadArchived(id, archiveInput(false));
  await service.setThreadArchived(id, archiveInput(false));
  expect(codex.unarchives).toBe(1);
  await service.resumeThread(id, { clientOperationId: operationId() });
  await service.startTurn(id, { clientOperationId: operationId(), text: 'continue' });
  expect((await service.getThread(id)).turns).toHaveLength(2);
});

it.each(['running', 'waitingApproval', 'waitingInput'] as const)(
  'rejects %s tasks before native archive, preserving execution and controls',
  async (status) => {
    const { service, codex, store } = setup();
    const id = await create(service);
    await service.startTurn(id, { clientOperationId: operationId(), text: 'still running' });
    codex.emit({ type: 'threadStatus', threadId: id, status });
    const marker = store.activeForThread(id);
    await expect(service.setThreadArchived(id, archiveInput())).rejects.toMatchObject({
      code: 'THREAD_BUSY',
    });
    expect(codex.archives).toBe(0);
    expect(codex.interrupts).toBe(0);
    expect(store.activeForThread(id)).toEqual(marker);
    expect((await service.getThread(id)).archived).toBe(false);
  },
);

it('discovers native archived history without a local link and after reopening the database', async () => {
  const { service, codex, projects, project, filename, db, store } = setup();
  const id = 'archived-in-cli';
  codex.threads.set(id, { ...threadView(id, project), archived: true });
  expect(store.getThreadLink(id)).toBeUndefined();
  expect((await service.listThreads('project', undefined, true)).data).toMatchObject([
    { id, archived: true },
  ]);
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
    expect(await recovered.getThread(id)).toMatchObject({ id, archived: true });
    await recovered.setThreadArchived(id, archiveInput(false));
    expect((await recovered.listThreads('project')).data).toMatchObject([{ id, archived: false }]);
    await recovered.shutdown();
  } finally {
    reopened.close();
  }
});

it('forwards the archived filter and opaque pagination cursor to Codex', async () => {
  const { service, codex, project } = setup();
  const list = vi.spyOn(codex, 'listThreads').mockResolvedValue({
    data: [{ ...threadView('native-archive', project), archived: true }],
    nextCursor: 'native-next-page',
  });
  const page = await service.listThreadSummaries('project', 'native-cursor', true);
  expect(list).toHaveBeenCalledWith(realpathSync(project), 'native-cursor', true);
  expect(page.nextCursor).toBe('native-next-page');
  expect(page.data).toMatchObject([{ id: 'native-archive', archived: true }]);
});

it('does not invent a saved archive when native archive fails', async () => {
  const { service, codex } = setup();
  const id = await create(service);
  vi.spyOn(codex, 'archiveThread').mockRejectedValue(
    new AppError('CODEX_REQUEST_FAILED', 'cannot archive', 400),
  );
  await expect(service.setThreadArchived(id, archiveInput())).rejects.toMatchObject({
    code: 'CODEX_REQUEST_FAILED',
  });
  expect(await service.getThread(id)).toMatchObject({ archived: false, managed: false });
});

it('retains unknown native receipts and never replays them, even after the archive is visible', async () => {
  const { service, codex } = setup();
  const id = await create(service);
  const original = codex.archiveThread.bind(codex);
  const call = vi.spyOn(codex, 'archiveThread').mockImplementation(async (id) => {
    await original(id);
    throw new CodexError('CODEX_TIMEOUT', 'lost reply', true);
  });
  const input = archiveInput();
  await expect(service.setThreadArchived(id, input)).rejects.toMatchObject({
    code: 'RESULT_UNKNOWN',
  });
  expect(await service.getThread(id)).toMatchObject({ archived: true });
  expect(await service.setThreadArchived(id, input)).toMatchObject({ status: 'unknown' });
  expect(call).toHaveBeenCalledTimes(1);
  await expect(service.setThreadArchived(id, archiveInput(false))).rejects.toMatchObject({
    code: 'THREAD_BUSY',
  });
  await expect(
    service.resumeThread(id, { clientOperationId: operationId() }),
  ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  await service.reconcileOperation(input.clientOperationId, {
    clientOperationId: operationId(),
    confirmEnded: true,
  });
  await service.setThreadArchived(id, archiveInput(false));
});

it('blocks starting and resuming while native archive is being checked', async () => {
  const { service, codex, project } = setup();
  const id = await create(service);
  const gate = deferred<ThreadView>();
  const read = vi.spyOn(codex, 'readThreadMetadata').mockReturnValueOnce(gate.promise);
  const archive = service.setThreadArchived(id, archiveInput());
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  await expect(
    service.startTurn(id, { clientOperationId: operationId(), text: 'race' }),
  ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  await expect(
    service.resumeThread(id, { clientOperationId: operationId() }),
  ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  gate.resolve(threadView(id, project));
  await archive;
  expect(codex.starts).toBe(0);
});

it('keeps native archive notifications newer than an older upstream list', async () => {
  const { service, codex, project } = setup();
  const id = await create(service);
  const gate = deferred<ThreadPage>();
  vi.spyOn(codex, 'listThreads').mockReturnValue(gate.promise);
  const read = service.listThreads('project');
  await service.setThreadArchived(id, archiveInput());
  gate.resolve({ data: [threadView(id, project)], nextCursor: 'next' });
  expect(await read).toEqual({ data: [], nextCursor: 'next' });
});

it('validates HTTP input, origins and project ownership before native dispatch', async () => {
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
  for (const body of [
    {},
    { archived: true },
    { ...archiveInput(), archived: 'true' },
    { ...archiveInput(), cwd: '/tmp' },
  ])
    expect((await post(body)).status).toBe(400);
  expect((await post(archiveInput(), 'https://foreign.invalid')).status).toBe(403);
  expect((await post(archiveInput())).status).toBe(200);
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
  await expect(service.setThreadArchived('outside', archiveInput())).rejects.toMatchObject({
    code: 'PROJECT_OWNERSHIP',
  });
  expect(codex.archives).toBe(1);
});

it('publishes an early native unarchive notification only after the lifecycle request finishes', async () => {
  const { service, codex } = setup();
  const id = await create(service);
  await service.setThreadArchived(id, archiveInput());
  const events: ServerMessage[] = [];
  service.subscribeOverview((event) => events.push(event));
  const gate = deferred<ThreadView>();
  vi.spyOn(codex, 'unarchiveThread').mockImplementation(async () => {
    codex.threads.get(id)!.archived = false;
    codex.emit({ type: 'threadArchive', threadId: id, archived: false });
    return gate.promise;
  });
  const unarchive = service.setThreadArchived(id, archiveInput(false));
  await vi.waitFor(() => expect(codex.unarchiveThread).toHaveBeenCalled());
  expect(events).toEqual([]);
  gate.resolve(await codex.readThread(id));
  await unarchive;
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'threadSummary',
        payload: expect.objectContaining({ id, archived: false }),
      }),
    ]),
  );
});

it('archives a new empty session without requesting its unmaterialized turn history', async () => {
  const { service, codex } = setup();
  const id = await create(service);
  const history = vi
    .spyOn(codex, 'readThread')
    .mockRejectedValue(new AppError('CODEX_REQUEST_FAILED', 'not materialized'));
  expect(await service.setThreadArchived(id, archiveInput())).toMatchObject({
    status: 'acknowledged',
  });
  expect(history).not.toHaveBeenCalled();
  expect(codex.archives).toBe(1);
});

it('does not let an unrelated title notification suppress an archived list result', async () => {
  const { service, codex } = setup();
  const id = await create(service);
  await service.startTurn(id, { clientOperationId: operationId(), text: 'saved history' });
  codex.complete(id, 'turn-1');
  const gate = deferred<ThreadPage>();
  vi.spyOn(codex, 'listThreads').mockReturnValueOnce(gate.promise);
  const listing = service.listThreads('project', undefined, true);
  codex.emit({ type: 'threadName', threadId: id, name: 'new title' });
  gate.resolve({ data: [{ ...(await codex.readThread(id)), archived: true }], nextCursor: null });
  expect((await listing).data).toMatchObject([{ id, archived: true, title: 'new title' }]);
});
