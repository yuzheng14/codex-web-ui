import { rmSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import type { ServerMessage } from '../../src/shared/types';
import { harness, operationId } from './domain-helpers';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.close();
});

it.each(['completed', 'failed', 'interrupted'] as const)(
  'broadcasts one live %s signal with safe metadata and never replays it',
  async (status) => {
    const ctx = harness();
    resources.push(ctx);
    const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
    const id = (created.result as { threadId: string }).threadId;
    const overview: ServerMessage[] = [];
    const stop = ctx.service.subscribeOverview((event) => overview.push(event));
    const cursor = ctx.service.events.cursor();
    await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'private prompt' });
    const turn = structuredClone(ctx.codex.threads.get(id)!.turns[0]!);
    turn.status = status;
    ctx.codex.emit({ type: 'turn', threadId: id, turn });
    ctx.codex.emit({ type: 'turn', threadId: id, turn });
    const completions = overview.filter(
      (event) => event.type === 'event' && event.kind === 'turnCompletion',
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      threadId: id,
      payload: { threadId: id, turnId: turn.id, projectId: 'project', title: id, status },
    });
    expect(JSON.stringify(completions)).not.toMatch(/private prompt|items|actions|cwd|error/);

    const replay: ServerMessage[] = [];
    (await ctx.service.subscribe(id, cursor, (event) => replay.push(event)))();
    expect(replay.some((event) => event.type === 'event' && event.kind === 'turnCompletion')).toBe(
      false,
    );
    const count = completions.length;
    await ctx.service.getThread(id);
    await ctx.service.listThreadSummaries('project');
    expect(
      overview.filter((event) => event.type === 'event' && event.kind === 'turnCompletion'),
    ).toHaveLength(count);
    stop();
    const fresh: ServerMessage[] = [];
    ctx.service.subscribeOverview((event) => fresh.push(event))();
    expect(fresh).toEqual([]);
  },
);

it('does not notify for uncertain runtime resets or unavailable projects', async () => {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  await ctx.service.startTurn(id, { clientOperationId: operationId(), text: 'private prompt' });
  const overview: ServerMessage[] = [];
  ctx.service.subscribeOverview((event) => overview.push(event));
  ctx.codex.reset();
  rmSync(ctx.project, { recursive: true });
  ctx.codex.complete(id, 'turn-1');
  expect(overview.some((event) => event.type === 'event' && event.kind === 'turnCompletion')).toBe(
    false,
  );
});

it.each(['command', 'file', 'network', 'permissions', 'questions', 'elicitation'] as const)(
  'broadcasts a new %s request once without replaying private request data',
  async (kind) => {
    const ctx = harness();
    resources.push(ctx);
    const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
    const threadId = (created.result as { threadId: string }).threadId;
    await ctx.service.startTurn(threadId, {
      clientOperationId: operationId(),
      text: 'private prompt',
    });
    const events: ServerMessage[] = [];
    ctx.service.subscribeOverview((event) => events.push(event));
    const cursor = ctx.service.events.cursor();
    const action = {
      actionId: 'request',
      codexEpoch: ctx.codex.epoch,
      rpcId: 1,
      kind,
      threadId,
      turnId: 'turn-1',
      status: 'pending' as const,
      title: 'private question',
      command: 'private command',
      options: [],
    };
    ctx.codex.emit({ type: 'action', action: structuredClone(action) });
    ctx.codex.emit({ type: 'action', action: structuredClone(action) });
    const signals = () =>
      events.filter((event) => event.type === 'event' && event.kind === 'attentionRequest');
    expect(signals()).toHaveLength(1);
    expect(signals()[0]).toMatchObject({
      payload: {
        threadId,
        projectId: 'project',
        title: threadId,
        kind: ['questions', 'elicitation'].includes(kind) ? 'answer' : 'approval',
        target: { kind: 'action', id: 'request' },
      },
    });
    expect(JSON.stringify(signals())).not.toMatch(/private|rpcId|codexEpoch|command/);
    const replay: ServerMessage[] = [];
    (await ctx.service.subscribe(threadId, cursor, (event) => replay.push(event)))();
    expect(
      replay.some((event) => event.type === 'event' && event.kind === 'attentionRequest'),
    ).toBe(false);
    await ctx.service.getThread(threadId);
    expect(signals()).toHaveLength(1);
    expect(ctx.service.getThreadAttention(threadId)).toHaveLength(1);
    ctx.codex.emit({ type: 'actionResolved', actionId: action.actionId });
    expect(ctx.service.getThreadAttention(threadId)).toEqual([]);
    ctx.codex.emit({
      type: 'action',
      action: { ...action, actionId: 'expired', status: 'expired' },
    });
    ctx.codex.emit({ type: 'action', action: { ...action, actionId: 'stale', codexEpoch: 'old' } });
    ctx.codex.complete(threadId, 'turn-1');
    ctx.codex.emit({ type: 'action', action: { ...action, actionId: 'late' } });
    expect(ctx.service.getThreadAttention(threadId)).toEqual([]);
    expect(signals()).toHaveLength(1);
  },
);

it('notifies once for an async question item and excludes partially or fully answered questions correctly', async () => {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const threadId = (created.result as { threadId: string }).threadId;
  await ctx.service.startTurn(threadId, { clientOperationId: operationId(), text: 'prompt' });
  const events: ServerMessage[] = [];
  ctx.service.subscribeOverview((event) => events.push(event));
  const question = {
    id: 'question',
    type: 'agentMessage' as const,
    delivery: 'async' as const,
    questions: [
      { title: 'private theme?', options: ['dark', 'light'] },
      { title: 'private name?', options: null },
    ],
  };
  const emitQuestion = () =>
    ctx.codex.emit({ type: 'item', threadId, turnId: 'turn-1', item: question });
  emitQuestion();
  emitQuestion();
  ctx.codex.complete(threadId, 'turn-1');
  expect(ctx.service.getThreadAttention(threadId)).toMatchObject([
    { kind: 'answer', target: { kind: 'question', id: 'question' } },
  ]);
  ctx.codex.emit({
    type: 'item',
    threadId,
    turnId: 'turn-1',
    item: {
      id: 'reply-1',
      type: 'userMessage',
      questionReplies: [
        {
          questionItemId: '["request_user_input_async","question",0]',
          question: 'private theme?',
          answer: 'dark',
        },
      ],
    },
  });
  expect(ctx.service.getThreadAttention(threadId)).toHaveLength(1);
  ctx.codex.emit({
    type: 'item',
    threadId,
    turnId: 'turn-1',
    item: {
      id: 'reply-2',
      type: 'userMessage',
      questionReplies: [
        { questionItemId: 'question', question: 'private name?', answer: 'private answer' },
      ],
    },
  });
  expect(ctx.service.getThreadAttention(threadId)).toEqual([]);
  emitQuestion();
  const signals = events.filter(
    (event) => event.type === 'event' && event.kind === 'attentionRequest',
  );
  expect(signals).toHaveLength(1);
  expect(JSON.stringify(signals)).not.toMatch(/private|dark|light|questions/);
});

it('does not expose requests from unavailable projects or interrupted async questions', async () => {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const threadId = (created.result as { threadId: string }).threadId;
  await ctx.service.startTurn(threadId, { clientOperationId: operationId(), text: 'prompt' });
  ctx.codex.emit({
    type: 'turn',
    threadId,
    turn: { ...structuredClone(ctx.codex.threads.get(threadId)!.turns[0]!), status: 'interrupted' },
  });
  const events: ServerMessage[] = [];
  ctx.service.subscribeOverview((event) => events.push(event));
  ctx.codex.emit({
    type: 'item',
    threadId,
    turnId: 'turn-1',
    item: {
      id: 'cancelled',
      type: 'agentMessage',
      questions: [{ title: 'cancelled?', options: null }],
    },
  });
  rmSync(ctx.project, { recursive: true });
  ctx.codex.emit({
    type: 'action',
    action: {
      actionId: 'unavailable',
      rpcId: 1,
      codexEpoch: ctx.codex.epoch,
      threadId,
      kind: 'command',
      status: 'pending',
      title: 'private',
      options: [],
    },
  });
  expect(events.some((event) => event.type === 'event' && event.kind === 'attentionRequest')).toBe(
    false,
  );
});
