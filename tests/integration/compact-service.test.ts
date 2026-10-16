import { afterEach, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import type { TurnView } from '../../src/shared/types.js';
import { deferred, harness, operationId, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const ctx of resources.splice(0)) ctx.close();
});
async function setup() {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'history' });
  ctx.codex.complete(id, 'turn-1');
  return { ...ctx, id };
}
function compaction(ctx: Awaited<ReturnType<typeof setup>>, status: TurnView['status']) {
  const turn: TurnView = {
    id: 'compact-turn',
    threadId: ctx.id,
    status,
    items: [{ id: 'compact-item', type: 'contextCompaction' }],
  };
  const thread = ctx.codex.threads.get(ctx.id)!;
  thread.turns = [...thread.turns.filter((entry) => entry.id !== turn.id), turn];
  thread.status = status;
  ctx.codex.emit({ type: 'turn', threadId: ctx.id, turn });
}

it('keeps the execution reservation after the empty acknowledgement until a new turn ends', async () => {
  const ctx = await setup();
  const input = { clientOperationId: operationId() };
  expect(await ctx.service.compactThread(ctx.id, input)).toMatchObject({
    kind: 'thread.compact',
    status: 'acknowledged',
    result: { threadId: ctx.id },
  });
  expect(ctx.store.activeForThread(ctx.id)).toMatchObject({ turnId: null });
  // A duplicate old completion cannot claim or release this new operation.
  ctx.codex.complete(ctx.id, 'turn-1');
  expect(ctx.store.activeForThread(ctx.id)).toMatchObject({ turnId: null });
  await expect(
    ctx.service.compactThread(ctx.id, { clientOperationId: operationId() }),
  ).rejects.toThrow();
  await expect(
    ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'too soon' }),
  ).rejects.toThrow();
  expect(ctx.codex.compactions).toBe(1);
  compaction(ctx, 'running');
  expect(ctx.store.activeForThread(ctx.id)).toMatchObject({ turnId: 'compact-turn' });
  compaction(ctx, 'completed');
  expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
  expect((await ctx.service.getThread(ctx.id)).turns.at(-1)?.items).toEqual([
    { id: 'compact-item', type: 'contextCompaction', status: 'completed' },
  ]);
  await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'continue' });
  expect(ctx.codex.starts).toBe(2);
});

it.each(['completed', 'failed', 'interrupted'] as const)(
  'accepts terminal %s evidence before the RPC acknowledgement without resurrecting its reservation',
  async (status) => {
    const ctx = await setup();
    const gate = deferred<void>();
    const call = vi.spyOn(ctx.codex, 'compactThread').mockReturnValue(gate.promise);
    const input = { clientOperationId: operationId() };
    const pending = ctx.service.compactThread(ctx.id, input);
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    compaction(ctx, 'running');
    compaction(ctx, status);
    expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
    gate.resolve();
    expect(await pending).toMatchObject({ status: 'acknowledged' });
    expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
    expect((await ctx.service.getThread(ctx.id)).turns.at(-1)?.status).toBe(status);
    await ctx.service.compactThread(ctx.id, input);
    expect(call).toHaveBeenCalledOnce();
  },
);

it('binds a new turn even when a history refresh has already populated it', async () => {
  const ctx = await setup();
  await ctx.service.compactThread(ctx.id, { clientOperationId: operationId() });
  const turn: TurnView = {
    id: 'compact-turn',
    threadId: ctx.id,
    status: 'running',
    items: [],
  };
  ctx.service.projection.turn(ctx.id, turn);
  compaction(ctx, 'completed');
  expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
});

it('releases a definite rejection but preserves an uncertain dispatch for reconciliation', async () => {
  const ctx = await setup();
  const call = vi.spyOn(ctx.codex, 'compactThread');
  call.mockRejectedValueOnce(new AppError('CODEX_REQUEST_FAILED', 'rejected', 400));
  await expect(
    ctx.service.compactThread(ctx.id, { clientOperationId: operationId() }),
  ).rejects.toThrow('rejected');
  expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
  call.mockRejectedValueOnce(new Error('connection lost'));
  await expect(
    ctx.service.compactThread(ctx.id, { clientOperationId: operationId() }),
  ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  expect(ctx.store.activeForThread(ctx.id)).toMatchObject({ state: 'unknown' });
});

it('guards unmanaged, archived, empty and active conversations without submitting compaction', async () => {
  const ctx = await setup();
  const external = threadView('external', ctx.project);
  ctx.codex.threads.set(external.id, external);
  await expect(
    ctx.service.compactThread(external.id, { clientOperationId: operationId() }),
  ).rejects.toThrow();
  const empty = await ctx.service.createThread('project', { clientOperationId: operationId() });
  await expect(
    ctx.service.compactThread((empty.result as { threadId: string }).threadId, {
      clientOperationId: operationId(),
    }),
  ).rejects.toMatchObject({ code: 'EMPTY_THREAD' });
  await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'active' });
  await expect(
    ctx.service.compactThread(ctx.id, { clientOperationId: operationId() }),
  ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  ctx.codex.complete(ctx.id, 'turn-2');
  await ctx.service.setThreadArchived(ctx.id, { clientOperationId: operationId(), archived: true });
  await expect(
    ctx.service.compactThread(ctx.id, { clientOperationId: operationId() }),
  ).rejects.toThrow();
  expect(ctx.codex.compactions).toBe(0);
});

it('requires explicit reconciliation after a restart before the compaction turn was known', async () => {
  const ctx = await setup();
  const input = { clientOperationId: operationId() };
  await ctx.service.compactThread(ctx.id, input);
  ctx.codex.reset();
  expect(ctx.store.activeForThread(ctx.id)).toMatchObject({ state: 'unknown', turnId: null });
  await ctx.service.reconcileOperation(input.clientOperationId, {
    clientOperationId: operationId(),
    confirmEnded: true,
  });
  expect(ctx.store.activeForThread(ctx.id)).toBeUndefined();
});
