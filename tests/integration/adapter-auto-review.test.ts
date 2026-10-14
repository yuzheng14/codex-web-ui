import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/codex/adapter.js';
import type { CodexEvent } from '../../src/codex/types.js';
import type { SimulatorOptions } from '../fixtures/app-server.js';

const resources: { adapter: CodexAdapter; dir: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.adapter.stop();
    await rm(resource.dir, { recursive: true, force: true });
  }
});
async function fixture(autoReview: SimulatorOptions['autoReview']) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-auto-review-adapter-'));
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({
        autoReview,
        autoReviewDelayMs: 30,
        turnDelayMs: 10,
        logPath: join(dir, 'requests.jsonl'),
      } satisfies SimulatorOptions),
    ],
  });
  resources.push({ adapter, dir });
  const events: CodexEvent[] = [];
  adapter.onEvent((event) => events.push(structuredClone(event)));
  await adapter.start();
  return {
    adapter,
    events,
    messages: async () =>
      (await readFile(join(dir, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
async function terminal(events: CodexEvent[]) {
  await expect
    .poll(() =>
      events.find(
        (event) =>
          event.type === 'turn' && ['completed', 'interrupted'].includes(event.turn.status),
      ),
    )
    .toBeDefined();
}

describe('automatic review notifications through a real app-server subprocess', () => {
  it.each(['denied', 'approved', 'timedOut', 'aborted'] as const)(
    'observes %s without replying to a notification or asking for approval',
    async (status) => {
      const { adapter, events, messages } = await fixture(status);
      const thread = await adapter.createThread(tmpdir());
      const turn = await adapter.startTurn(thread.id, thread.cwd, 'observe an automatic review');
      await terminal(events);
      const reviews = events.filter((event) => event.type === 'autoReview');
      expect(reviews).toHaveLength(2);
      const started = reviews[0]!;
      const completed = reviews[1]!;
      expect(started).toMatchObject({
        threadId: thread.id,
        turnId: turn.id,
        review: {
          status: 'inProgress',
          cwd: thread.cwd,
          reviewId: expect.any(String),
          targetItemId: expect.any(String),
          startedAtMs: expect.any(Number),
        },
      });
      expect(completed).toMatchObject({
        threadId: thread.id,
        turnId: turn.id,
        review: {
          reviewId: started.review.reviewId,
          targetItemId: started.review.targetItemId,
          status,
          rationale: expect.any(String),
          startedAtMs: started.review.startedAtMs,
          completedAtMs: expect.any(Number),
        },
      });
      expect(completed.review.actionLabel).toBeTruthy();
      expect(completed.review.actionSummary).toContain(
        status === 'approved' ? 'git status' : 'curl --fail --upload-file',
      );
      if (status === 'denied')
        expect(completed.review).toMatchObject({
          riskLevel: 'high',
          userAuthorization: 'low',
          rationale: expect.stringContaining('当前请求未授权发布该文件'),
        });
      const history = await adapter.readThread(thread.id);
      const executed = history.turns[0]!.items.filter((item) => item.type === 'commandExecution');
      expect(executed).toHaveLength(status === 'approved' ? 1 : 0);
      if (status === 'approved')
        expect(executed[0]).toMatchObject({
          id: started.review.targetItemId,
          command: completed.review.actionSummary,
          status: 'completed',
        });
      expect(
        events.some((event) => event.type === 'action' || event.type === 'actionResolved'),
      ).toBe(false);
      const requests = await messages();
      expect(requests.every((message) => Object.hasOwn(message, 'method'))).toBe(true);
      expect(
        requests.some((message) => /approve|resolve|permission/i.test(String(message.method))),
      ).toBe(false);
    },
  );

  it('does not invent a review outcome when a turn ends without a completion notification', async () => {
    const { adapter, events, messages } = await fixture('unfinished');
    const thread = await adapter.createThread(tmpdir());
    await adapter.startTurn(thread.id, thread.cwd, 'finish without review outcome');
    await terminal(events);
    const reviews = events.filter((event) => event.type === 'autoReview');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.review.status).toBe('inProgress');
    expect(
      (await adapter.readThread(thread.id)).turns[0]?.items.some(
        (item) => item.type === 'commandExecution',
      ),
    ).toBe(false);
    expect((await messages()).every((message) => Object.hasOwn(message, 'method'))).toBe(true);
  });
});
