import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/codex/adapter.js';
import { compactThreadForTransport } from '../../src/server/snapshot.js';
import { mapItem } from '../../src/codex/mapping.js';
import type { ServerNotification } from '../../src/codex/generated/ServerNotification.js';
import type { CodexEvent } from '../../src/codex/types.js';
import type { ServerMessage, ThreadView } from '../../src/shared/types.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(async () => {
  for (const ctx of resources.splice(0)) {
    await ctx.service.shutdown();
    ctx.close();
  }
});
async function setup() {
  const ctx = harness();
  resources.push(ctx);
  const result = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const threadId = (result.result as { threadId: string }).threadId;
  await ctx.service.startTurn(threadId, { clientOperationId: operationId(), text: '继续工作' });
  const history = ctx.codex.threads.get(threadId)!;
  const turn = history.turns[0]!;
  const item = { id: 'compact-1', type: 'contextCompaction' };
  turn.items.push(item); // Persisted payload deliberately has no lifecycle status.
  const emit = (status: string, id = item.id) =>
    ctx.codex.emit({ type: 'item', threadId, turnId: turn.id, item: { ...item, id, status } });
  const read = () => ctx.service.getThread(threadId);
  const state = () =>
    ctx.service.projection.get(threadId)!.turns[0]!.items.find((entry) => entry.id === item.id)!;
  return { ...ctx, threadId, turn, history, emit, read, state };
}

describe('context compaction lifecycle', () => {
  it('maps actual item lifecycle notifications and the legacy completion without exposing raw details', () => {
    const adapter = new CodexAdapter({ binary: process.execPath });
    const events: CodexEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    const identity = { threadId: 'thread', turnId: 'turn' };
    for (const method of ['item/started', 'item/completed'] as const)
      adapter['notification']({
        method,
        params: {
          ...identity,
          item: { id: 'compact', type: 'contextCompaction' },
          startedAtMs: 1,
          completedAtMs: 2,
        },
      } as ServerNotification);
    adapter['notification']({ method: 'thread/compacted', params: identity });
    expect(events).toEqual([
      {
        type: 'item',
        ...identity,
        item: { id: 'compact', type: 'contextCompaction', status: 'inProgress' },
      },
      {
        type: 'item',
        ...identity,
        item: { id: 'compact', type: 'contextCompaction', status: 'completed' },
      },
      { type: 'compactionCompleted', ...identity },
    ]);
    expect(mapItem({ id: 'history', type: 'contextCompaction' })).toEqual({
      id: 'history',
      type: 'contextCompaction',
    });
  });

  it('preserves a live start through reads and subscriptions, then resumes the same active task', async () => {
    const ctx = await setup();
    ctx.emit('inProgress');
    const marker = ctx.store.activeForThread(ctx.threadId);
    await ctx.read();
    expect(ctx.state().status).toBe('inProgress');
    const messages: ServerMessage[] = [];
    const unsubscribe = await ctx.service.subscribe(ctx.threadId, undefined, (message) =>
      messages.push(message),
    );
    expect(messages[0]).toMatchObject({
      type: 'snapshot',
      data: {
        turns: [
          { items: expect.arrayContaining([expect.objectContaining({ status: 'inProgress' })]) },
        ],
      },
    });
    ctx.emit('completed');
    ctx.codex.emit({ type: 'compactionCompleted', threadId: ctx.threadId, turnId: ctx.turn.id });
    ctx.emit('inProgress'); // Late duplicate must not restart the completed item.
    await ctx.read();
    expect(ctx.state().status).toBe('completed');
    expect(ctx.store.activeForThread(ctx.threadId)).toEqual(marker);
    expect(ctx.service.projection.get(ctx.threadId)!.turns[0]!.status).toBe('running');
    expect(
      ctx.service.projection
        .get(ctx.threadId)!
        .turns[0]!.items.filter((i) => i.type === 'contextCompaction'),
    ).toHaveLength(1);
    ctx.emit('inProgress', 'compact-2');
    expect(ctx.service.projection.get(ctx.threadId)!.turns[0]!.items.at(-1)?.status).toBe(
      'inProgress',
    );
    unsubscribe();
  });

  it('does not let a status-free history merge erase observed start or completion', async () => {
    const ctx = await setup();
    for (const status of ['inProgress', 'completed']) {
      ctx.emit(status);
      ctx.service.projection.turn(ctx.threadId, structuredClone(ctx.turn));
      expect(ctx.state().status).toBe(status);
    }
  });

  it('accepts a legacy completion only for its matching known compaction', async () => {
    const ctx = await setup();
    ctx.emit('inProgress');
    for (const [threadId, turnId] of [
      ['other', ctx.turn.id],
      [ctx.threadId, 'other'],
    ] as const)
      ctx.codex.emit({ type: 'compactionCompleted', threadId, turnId });
    expect(ctx.state().status).toBe('inProgress');
    ctx.codex.emit({ type: 'compactionCompleted', threadId: ctx.threadId, turnId: ctx.turn.id });
    expect(ctx.state().status).toBe('completed');
  });

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'settles an unfinished compaction on %s, including history recovery',
    async (status) => {
      const ctx = await setup();
      ctx.emit('inProgress');
      ctx.turn.status = status;
      ctx.history.status = 'idle';
      if (status === 'failed') ctx.turn.error = '模型服务不可用';
      await ctx.read();
      expect(ctx.state().status).toBe(status === 'completed' ? 'unknown' : status);
      if (status === 'failed') expect(ctx.state().error).toBe('模型服务不可用');
      ctx.emit('inProgress');
      expect(ctx.state().status).not.toBe('inProgress');
    },
  );

  it('shows a non-retry error immediately, but retains execution ownership and earlier successful compactions', async () => {
    const ctx = await setup();
    ctx.emit('inProgress');
    ctx.codex.emit({
      type: 'turnError',
      threadId: ctx.threadId,
      turnId: ctx.turn.id,
      message: 'retrying',
      willRetry: true,
    });
    expect(ctx.state().status).toBe('inProgress');
    ctx.codex.emit({
      type: 'turnError',
      threadId: ctx.threadId,
      turnId: ctx.turn.id,
      message: '压缩失败',
      willRetry: false,
    });
    ctx.emit('completed');
    await ctx.read();
    expect(ctx.state()).toMatchObject({ status: 'failed', error: '压缩失败' });
    expect(ctx.store.activeForThread(ctx.threadId)).toBeDefined();
    ctx.emit('completed', 'previous-success');
    ctx.turn.status = 'failed';
    await ctx.read();
    expect(
      ctx.service.projection
        .get(ctx.threadId)!
        .turns[0]!.items.find((i) => i.id === 'previous-success')?.status,
    ).toBe('completed');
  });

  it.each(['idle', 'failed', 'unknown'] as const)(
    'clears the spinner on thread %s without claiming success',
    async (status) => {
      const ctx = await setup();
      ctx.emit('inProgress');
      ctx.codex.emit({ type: 'threadStatus', threadId: ctx.threadId, status });
      expect(ctx.state().status).toBe('unknown');
    },
  );

  it('does not infer a live start from history and does not let stale reads replace newer notifications', async () => {
    const ctx = await setup();
    ctx.service.projection.thread({
      ...ctx.service.projection.get(ctx.threadId)!,
      turns: structuredClone(ctx.history.turns),
    });
    await ctx.read();
    expect(ctx.state().status).toBeUndefined();
    const stale = structuredClone(ctx.history);
    stale.turns[0]!.status = 'completed';
    const gate = deferred<ThreadView>();
    const entered = deferred<void>();
    vi.spyOn(ctx.codex, 'readThread').mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const pending = ctx.read();
    await entered.promise;
    ctx.emit('inProgress');
    gate.resolve(stale);
    await pending;
    expect(ctx.state().status).toBe('inProgress');
    ctx.codex.ready = false;
    ctx.codex.emit({ type: 'runtime', diagnostics: ctx.codex.diagnostics() });
    expect(ctx.state().status).toBe('unknown');
  });

  it('keeps the ongoing compaction in a size-limited reconnect snapshot', async () => {
    const ctx = await setup();
    ctx.emit('inProgress');
    const thread = structuredClone(ctx.service.projection.get(ctx.threadId)!);
    thread.turns[0]!.items.push(
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `tool-${i}`,
        type: 'commandExecution',
        output: 'x'.repeat(1000),
      })),
    );
    const snapshot = compactThreadForTransport(thread, 1500);
    expect(snapshot.turns[0]!.items).toContainEqual({
      id: 'compact-1',
      type: 'contextCompaction',
      status: 'inProgress',
      truncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(1500);
  });

  it('restores completed historical records without making them active', async () => {
    const ctx = await setup();
    ctx.turn.status = 'completed';
    ctx.history.status = 'idle';
    await ctx.read();
    expect(ctx.state().status).toBe('completed');
  });
});
