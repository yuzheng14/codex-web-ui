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
