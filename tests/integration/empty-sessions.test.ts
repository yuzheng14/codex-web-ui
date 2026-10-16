import { afterEach, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import type { ServerMessage, TurnView } from '../../src/shared/types.js';
import { GatewayService } from '../../src/server/service.js';
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
  return { ...ctx, id };
}

it('keeps an unsent draft usable in detail without listing it or restoring it as history', async () => {
  const ctx = await setup();
  const detail: ServerMessage[] = [];
  const overview: ServerMessage[] = [];
  ctx.service.subscribeOverview((event) => overview.push(event));
  const stop = await ctx.service.subscribe(ctx.id, undefined, (event) => detail.push(event));
  expect(detail[0]).toMatchObject({
    type: 'snapshot',
    data: { id: ctx.id, managed: true, historyVisible: false, turns: [] },
  });
  ctx.codex.emit({ type: 'threadName', threadId: ctx.id, name: '新会话' });
  expect(overview.at(-1)).toMatchObject({ payload: { historyVisible: false } });
  expect((await ctx.service.listThreads('project')).data).toEqual([]);
  stop();

  const recovered = new GatewayService(ctx);
  expect(await recovered.getThread(ctx.id)).toMatchObject({ historyVisible: false, turns: [] });
  expect((await recovered.listThreads('project')).data).toEqual([]);
});

it('preserves native history summaries without turns and titles that resemble placeholders', async () => {
  const ctx = await setup();
  const history = { ...threadView('history', ctx.project), title: '新会话', hasMessages: true };
  ctx.codex.threads.set(history.id, history);
  expect((await ctx.service.listThreads('project')).data).toMatchObject([
    { id: history.id, historyVisible: true, turns: [] },
  ]);
});

it('checks remembered selections with metadata without reading or subscribing to full history', async () => {
  const ctx = await setup();
  const history = vi.spyOn(ctx.codex, 'readThread');
  const recovered = new GatewayService(ctx);
  expect(await recovered.getThreadMetadata(ctx.id)).toMatchObject({
    historyVisible: false,
    hasMessages: false,
    turns: [],
  });
  expect(history).not.toHaveBeenCalled();
  expect(recovered.projection.get(ctx.id)).toBeUndefined();
  await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'saved input' });
  expect(await ctx.service.getThreadMetadata(ctx.id)).toMatchObject({
    historyVisible: true,
    turns: [],
    actions: [],
    execution: { ended: false },
  });
});

it('lists a first message before its turn or receipt arrives, then removes a definite rejection', async () => {
  const ctx = await setup();
  const gate = deferred<TurnView>();
  vi.spyOn(ctx.codex, 'startTurn').mockReturnValue(gate.promise);
  const overview: ServerMessage[] = [];
  ctx.service.subscribeOverview((event) => overview.push(event));
  const sending = ctx.service.startTurn(ctx.id, {
    clientOperationId: operationId(),
    text: 'first message',
  });
  const rejected = expect(sending).rejects.toMatchObject({ code: 'REJECTED' });
  await vi.waitFor(() => expect(ctx.store.activeForThread(ctx.id)).toBeDefined());
  expect((await ctx.service.listThreads('project')).data).toMatchObject([
    { id: ctx.id, historyVisible: true, turns: [], execution: { ended: false } },
  ]);
  expect(overview.at(-1)).toMatchObject({ payload: { historyVisible: true } });
  gate.reject(new AppError('REJECTED', 'Not accepted', 400));
  await rejected;
  expect((await ctx.service.listThreads('project')).data).toEqual([]);
  expect(overview.at(-1)).toMatchObject({ payload: { historyVisible: false } });
  expect(await ctx.service.getThread(ctx.id)).toMatchObject({
    managed: true,
    historyVisible: false,
  });
});

it('keeps an uncertain first message discoverable across gateway restarts and devices', async () => {
  const ctx = await setup();
  vi.spyOn(ctx.codex, 'startTurn').mockRejectedValue(new Error('Connection closed after dispatch'));
  vi.spyOn(ctx.codex, 'listThreads').mockResolvedValue({ data: [], nextCursor: null });
  const input = { clientOperationId: operationId(), text: 'possibly accepted' };
  await expect(ctx.service.startTurn(ctx.id, input)).rejects.toMatchObject({
    code: 'RESULT_UNKNOWN',
  });
  expect((await ctx.service.listThreads('project')).data).toMatchObject([
    { id: ctx.id, historyVisible: true, execution: { operationId: input.clientOperationId } },
  ]);
  ctx.codex.reset();
  const recovered = new GatewayService(ctx);
  // No previous browser selection or loaded projection is needed for discovery.
  expect((await recovered.listThreads('project')).data).toMatchObject([
    { id: ctx.id, status: 'unknown', historyVisible: true, execution: { ended: false } },
  ]);
  expect(await recovered.getThread(ctx.id)).toMatchObject({ historyVisible: true });
});

it('retains accepted messages when a turn fails, and keeps pending approvals visible', async () => {
  const ctx = await setup();
  await ctx.service.startTurn(ctx.id, { clientOperationId: operationId(), text: 'accepted input' });
  ctx.codex.complete(ctx.id, 'turn-1');
  ctx.codex.threads.get(ctx.id)!.turns[0]!.status = 'failed';
  ctx.codex.emit({
    type: 'turn',
    threadId: ctx.id,
    turn: ctx.codex.threads.get(ctx.id)!.turns[0]!,
  });
  expect((await ctx.service.listThreads('project')).data).toMatchObject([
    { id: ctx.id, historyVisible: true, turns: [{ status: 'failed' }] },
  ]);
  const empty = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const emptyId = (empty.result as { threadId: string }).threadId;
  ctx.codex.emit({
    type: 'action',
    action: {
      actionId: 'early-approval',
      threadId: emptyId,
      codexEpoch: ctx.codex.epoch,
      rpcId: 1,
      kind: 'command',
      status: 'pending',
      title: 'Approval',
      options: [{ id: 'accept', label: 'Allow' }],
    },
  });
  expect(await ctx.service.getThread(emptyId)).toMatchObject({ historyVisible: true });
});
