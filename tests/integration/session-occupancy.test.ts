import { afterEach, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { CodexError } from '../../src/codex/transport.js';
import { deferred, harness, operationId, threadView } from './domain-helpers.js';
import type { ThreadView } from '../../src/shared/types.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const ctx of resources.splice(0)) ctx.close();
});
function setup() {
  const ctx = harness();
  resources.push(ctx);
  const thread = threadView('external-cli', ctx.project);
  thread.source = 'cli';
  ctx.codex.threads.set(thread.id, thread);
  return { ...ctx, thread };
}

it('shows a confirmed conflict, leaves the original untouched, and recovers after release', async () => {
  const ctx = setup();
  const resume = vi
    .spyOn(ctx.codex, 'resumeThread')
    .mockRejectedValueOnce(new AppError('THREAD_IN_USE', '此会话正被其他进程使用', 409));
  const firstId = operationId();
  await expect(
    ctx.service.resumeThread(ctx.thread.id, { clientOperationId: firstId }),
  ).rejects.toMatchObject({ code: 'THREAD_IN_USE' });
  expect(ctx.store.get(firstId)?.state).toBe('failed');
  expect(await ctx.service.getThread(ctx.thread.id)).toMatchObject({
    managed: false,
    resumeError: { code: 'THREAD_IN_USE' },
  });
  expect(ctx.codex.interrupts).toBe(0);
  expect(ctx.codex.starts).toBe(0);
  await ctx.service.resumeThread(ctx.thread.id, { clientOperationId: operationId() });
  const recovered = await ctx.service.getThread(ctx.thread.id);
  expect(recovered.managed).toBe(true);
  expect(recovered.resumeError).toBeUndefined();
  await ctx.service.resumeThread(ctx.thread.id, { clientOperationId: operationId() });
  expect(resume).toHaveBeenCalledTimes(2);
});

it('forks a writer-locked history without resuming or interrupting its source', async () => {
  const ctx = setup();
  const resume = vi
    .spyOn(ctx.codex, 'resumeThread')
    .mockRejectedValue(new AppError('THREAD_IN_USE', '此会话正被其他进程使用', 409));
  await expect(
    ctx.service.resumeThread(ctx.thread.id, { clientOperationId: operationId() }),
  ).rejects.toThrow();
  const fork = await ctx.service.forkThread(ctx.thread.id, { clientOperationId: operationId() });
  expect(fork.status).toBe('acknowledged');
  expect(resume).toHaveBeenCalledTimes(1);
  expect(ctx.codex.interrupts).toBe(0);
  expect((await ctx.service.getThread(ctx.thread.id)).managed).toBe(false);
  expect(
    (await ctx.service.getThread((fork.result as { threadId: string }).threadId)).managed,
  ).toBe(true);
});

it('shares one writer acquisition across simultaneous browser requests', async () => {
  const ctx = setup();
  const gate = deferred<ThreadView>();
  const resume = vi.spyOn(ctx.codex, 'resumeThread').mockReturnValue(gate.promise);
  const first = ctx.service.resumeThread(ctx.thread.id, { clientOperationId: operationId() });
  const second = ctx.service.resumeThread(ctx.thread.id, { clientOperationId: operationId() });
  await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
  gate.resolve(ctx.thread);
  expect((await Promise.all([first, second])).map((x) => x.status)).toEqual([
    'acknowledged',
    'acknowledged',
  ]);
  expect(resume).toHaveBeenCalledTimes(1);
});

it('keeps ordinary failures distinct from writer conflicts', async () => {
  const ctx = setup();
  vi.spyOn(ctx.codex, 'resumeThread').mockRejectedValue(
    new CodexError('CODEX_REQUEST_FAILED', 'Invalid history format', false, -32600),
  );
  await expect(
    ctx.service.resumeThread(ctx.thread.id, { clientOperationId: operationId() }),
  ).rejects.toMatchObject({ code: 'CODEX_REQUEST_FAILED' });
  expect((await ctx.service.getThread(ctx.thread.id)).resumeError).toMatchObject({
    code: 'CODEX_REQUEST_FAILED',
    message: 'Invalid history format',
  });
});

it('keeps lost receipts unknown and does not claim that another process owns the thread', async () => {
  const ctx = setup();
  vi.spyOn(ctx.codex, 'resumeThread').mockRejectedValue(
    new CodexError('RESULT_UNKNOWN', 'Timed out', true),
  );
  const id = operationId();
  await expect(
    ctx.service.resumeThread(ctx.thread.id, { clientOperationId: id }),
  ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  expect(ctx.store.get(id)?.state).toBe('unknown');
  expect((await ctx.service.getThread(ctx.thread.id)).resumeError).toBeUndefined();
});

it('does not mark an old resume response as owned by a restarted runtime', async () => {
  const ctx = setup();
  const gate = deferred<ThreadView>();
  vi.spyOn(ctx.codex, 'resumeThread').mockReturnValue(gate.promise);
  const id = operationId();
  const pending = ctx.service.resumeThread(ctx.thread.id, { clientOperationId: id });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
  await vi.waitFor(() => expect(ctx.codex.resumeThread).toHaveBeenCalledTimes(1));
  ctx.codex.reset();
  gate.resolve(ctx.thread);
  await rejected;
  expect((await ctx.service.getThread(ctx.thread.id)).managed).toBe(false);
});
