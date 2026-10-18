import { afterEach, expect, it, vi } from 'vitest';
import type { PendingAction } from '../../src/shared/types.js';
import { harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const ctx of resources.splice(0)) ctx.close();
});

it('keeps cancellation, parallel tool output and late events scoped to their original turn', async () => {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'first' });
  const approval: PendingAction = {
    actionId: 'old-approval',
    codexEpoch: ctx.codex.epoch,
    rpcId: 0,
    threadId: id,
    turnId: 'turn-1',
    kind: 'command',
    status: 'pending',
    title: 'Nested tool',
    options: [{ id: 'accept', label: '允许' }],
  };
  ctx.codex.emit({ type: 'action', action: approval });
  await ctx.service.interrupt(id, { clientOperationId: operationId(), expectedTurnId: 'turn-1' });
  expect(ctx.store.activeForThread(id)?.turnId).toBe('turn-1');
  await expect(
    ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'too early' }),
  ).rejects.toMatchObject({ code: 'THREAD_BUSY' });
  const old = { ...ctx.codex.threads.get(id)!.turns[0]!, status: 'interrupted' as const };
  ctx.codex.emit({ type: 'turn', threadId: id, turn: old });
  await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'next' });
  const marker = ctx.store.activeForThread(id);
  for (const [turnId, itemId, delta] of [
    ['turn-2', 'tool-b', 'B1'],
    ['turn-1', 'nested-tool', 'late'],
    ['turn-2', 'tool-a', 'A1'],
    ['turn-2', 'tool-b', 'B2'],
  ])
    ctx.codex.emit({
      type: 'delta',
      threadId: id,
      turnId: turnId!,
      itemId: itemId!,
      field: 'output',
      itemType: 'commandExecution',
      delta: delta!,
    });
  ctx.codex.emit({
    type: 'item',
    threadId: id,
    turnId: 'turn-1',
    item: { id: 'nested-tool', type: 'commandExecution', status: 'declined', output: 'cancelled' },
  });
  ctx.codex.emit({ type: 'turn', threadId: id, turn: old });
  expect(ctx.service.projection.get(id)?.status).toBe('running');
  ctx.codex.emit({
    type: 'action',
    action: { ...approval, actionId: 'late-approval', status: 'pending' },
  });
  const thread = ctx.service.projection.get(id)!;
  expect(thread.status).toBe('running');
  expect(thread.turns[1]?.status).toBe('running');
  expect(
    thread.turns[1]?.items.filter((item) => item.output).map((item) => [item.id, item.output]),
  ).toEqual([
    ['tool-b', 'B1B2'],
    ['tool-a', 'A1'],
  ]);
  expect(thread.turns[0]?.items.find((item) => item.id === 'nested-tool')?.output).toBe(
    'cancelled',
  );
  expect(ctx.store.activeForThread(id)).toEqual(marker);
  for (const actionId of ['old-approval', 'late-approval']) {
    await expect(
      ctx.service.resolveAction(actionId, {
        clientOperationId: operationId(),
        resolution: { decision: 'accept' },
      }),
    ).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
  }
  expect(ctx.codex.replies).toBe(0);
});

it('does not attach a cancelled turn to a new operation awaiting its first notification', async () => {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'first' });
  ctx.codex.complete(id, 'turn-1');
  const old = structuredClone(ctx.codex.threads.get(id)!.turns[0]!);
  const original = ctx.codex.startTurn.bind(ctx.codex);
  vi.spyOn(ctx.codex, 'startTurn').mockImplementation(async (...args) => {
    ctx.codex.emit({ type: 'turn', threadId: id, turn: old });
    return original(...args);
  });
  const operation = operationId();
  await ctx.service.startTurn(id, { clientOperationId: operation, text: 'next' });
  expect(ctx.store.activeForThread(id)).toMatchObject({ operationId: operation, turnId: 'turn-2' });
  expect(ctx.service.projection.get(id)?.status).toBe('running');
});
