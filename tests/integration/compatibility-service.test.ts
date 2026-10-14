import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfirmCompatibilityInput,
  PendingAction,
  ServerMessage,
  ThreadView,
} from '../../src/shared/types.js';
import { GatewayService } from '../../src/server/service.js';
import { deferred, harness, operationId, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
function setup() {
  const ctx = harness();
  resources.push(ctx);
  return ctx;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const ctx of resources.splice(0)) ctx.close();
});
function unverified(ctx: ReturnType<typeof harness>) {
  ctx.codex.codexVersion = 'new-version';
  ctx.codex.compatibility = 'unverified';
}
function confirmation(ctx: ReturnType<typeof harness>): ConfirmCompatibilityInput {
  const info = ctx.service.getSystem();
  return {
    clientOperationId: operationId(),
    codexEpoch: info.codexEpoch,
    codexVersion: info.codexVersion!,
    verifiedVersion: info.verifiedVersion,
    confirm: true,
  };
}
async function create(ctx: ReturnType<typeof harness>) {
  const result = await ctx.service.createThread('project', { clientOperationId: operationId() });
  return (result.result as { threadId: string }).threadId;
}
function approval(ctx: ReturnType<typeof harness>, threadId: string): PendingAction {
  const action: PendingAction = {
    actionId: 'approval',
    codexEpoch: ctx.codex.epoch,
    rpcId: 0,
    kind: 'command',
    threadId,
    turnId: 'turn-1',
    status: 'pending',
    title: '运行命令',
    options: [{ id: 'accept', label: '允许' }],
  };
  ctx.codex.emit({ type: 'action', action });
  return action;
}

describe('explicit compatibility consent belongs to one running gateway and Codex fingerprint', () => {
  it('blocks every unsafe mutation before dispatch while leaving reads and interruption usable', async () => {
    const ctx = setup();
    const idle = await create(ctx);
    const running = await create(ctx);
    await ctx.service.startTurn(running, { clientOperationId: operationId(), text: 'running' });
    const action = approval(ctx, running);
    unverified(ctx);
    const dispatch = vi.spyOn(ctx.store, 'dispatch');
    const cases = [
      () => ctx.service.createThread('project', { clientOperationId: operationId() }),
      () => ctx.service.resumeThread(idle, { clientOperationId: operationId() }),
      () => ctx.service.forkThread(idle, { clientOperationId: operationId() }),
      () => ctx.service.startTurn(idle, { clientOperationId: operationId(), text: 'blocked' }),
      () =>
        ctx.service.steer(running, {
          clientOperationId: operationId(),
          expectedTurnId: 'turn-1',
          text: 'blocked',
        }),
      () =>
        ctx.service.resolveAction(action.actionId, {
          clientOperationId: operationId(),
          resolution: { decision: 'accept' },
        }),
    ];
    for (const attempt of cases)
      await expect(attempt()).rejects.toMatchObject({
        code: 'COMPATIBILITY_CONFIRMATION_REQUIRED',
        status: 409,
      });
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.codex).toMatchObject({
      creates: 2,
      starts: 1,
      resumes: 0,
      forks: 0,
      steers: 0,
      replies: 0,
    });
    expect(ctx.service.getSystem().compatibilityConfirmation).toBe('required');
    expect((await ctx.service.getThread(running)).actions[0]?.status).toBe('pending');
    expect((await ctx.service.listThreads('project')).data).toHaveLength(2);
    expect(ctx.service.listProjects()).toHaveLength(1);
    await ctx.service.interrupt(running, {
      clientOperationId: operationId(),
      expectedTurnId: 'turn-1',
    });
    expect(ctx.codex.interrupts).toBe(1);
    expect(ctx.store.activeForThread(running)).toBeDefined();
  });

  it('persists the receipt before granting consent, broadcasts to tabs, and deduplicates confirmation', async () => {
    const ctx = setup();
    unverified(ctx);
    const input = confirmation(ctx);
    const firstTab: ServerMessage[] = [];
    const secondTab: ServerMessage[] = [];
    ctx.service.subscribeRuntime((event) => {
      expect(ctx.store.get(input.clientOperationId)?.state).toBe('acknowledged');
      firstTab.push(event);
    });
    ctx.service.subscribeRuntime((event) => secondTab.push(event));
    const first = await ctx.service.confirmCompatibility(input);
    expect(first).toMatchObject({
      status: 'acknowledged',
      kind: 'system.compatibility.confirm',
      result: { compatibilityConfirmation: 'confirmed' },
    });
    expect(ctx.service.getOperation(input.clientOperationId)).toEqual(first);
    expect(ctx.service.getSystem()).toMatchObject({
      compatibility: 'unverified',
      compatibilityConfirmation: 'confirmed',
    });
    expect(firstTab).toHaveLength(1);
    expect(secondTab).toEqual(firstTab);
    expect(await ctx.service.confirmCompatibility(input)).toEqual(first);
    expect(firstTab).toHaveLength(1);
    await create(ctx);
    expect(ctx.codex.creates).toBe(1);
    await expect(
      ctx.service.confirmCompatibility({ ...input, verifiedVersion: 'different' }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });

  it('never grants consent or broadcasts success when acknowledgement cannot be saved', async () => {
    const ctx = setup();
    unverified(ctx);
    const events: ServerMessage[] = [];
    ctx.service.subscribeRuntime((event) => events.push(event));
    const input = confirmation(ctx);
    vi.spyOn(ctx.store, 'acknowledge').mockImplementationOnce(() => {
      throw new Error('simulated database write failure');
    });
    await expect(ctx.service.confirmCompatibility(input)).rejects.toMatchObject({
      code: 'RESULT_UNKNOWN',
    });
    expect(ctx.service.getSystem().compatibilityConfirmation).toBe('required');
    expect(ctx.service.getOperation(input.clientOperationId).status).toBe('unknown');
    expect(events).toHaveLength(0);
  });

  it.each(['epoch', 'codexVersion', 'verifiedVersion'] as const)(
    'invalidates consent and stale confirmation when %s changes, without replaying the old receipt',
    async (field) => {
      const ctx = setup();
      unverified(ctx);
      const original = confirmation(ctx);
      await ctx.service.confirmCompatibility(original);
      const originalValue = ctx.codex[field];
      ctx.codex[field] = 'changed';
      ctx.codex.emit({ type: 'runtime', diagnostics: ctx.codex.diagnostics() });
      expect(ctx.service.getSystem().compatibilityConfirmation).toBe('required');
      await expect(
        ctx.service.confirmCompatibility({ ...original, clientOperationId: operationId() }),
      ).rejects.toMatchObject({ code: 'COMPATIBILITY_CHANGED' });
      expect((await ctx.service.confirmCompatibility(original)).status).toBe('acknowledged');
      expect(ctx.service.getSystem().compatibilityConfirmation).toBe('required');
      ctx.codex[field] = originalValue!;
      expect(ctx.service.getSystem().compatibilityConfirmation).toBe('required');
      await ctx.service.confirmCompatibility(confirmation(ctx));
      expect(ctx.service.getSystem().compatibilityConfirmation).toBe('confirmed');
    },
  );

  it('does not restore consent from SQLite after gateway restart, or after a Codex restart', async () => {
    const ctx = setup();
    unverified(ctx);
    const input = confirmation(ctx);
    await ctx.service.confirmCompatibility(input);
    const restarted = new GatewayService({
      store: ctx.store,
      projects: ctx.projects,
      codex: ctx.codex,
    });
    expect(restarted.getSystem().compatibilityConfirmation).toBe('required');
    expect((await restarted.confirmCompatibility(input)).status).toBe('acknowledged');
    expect(restarted.getSystem().compatibilityConfirmation).toBe('required');
    await restarted.confirmCompatibility({ ...input, clientOperationId: operationId() });
    expect(restarted.getSystem().compatibilityConfirmation).toBe('confirmed');
    ctx.codex.reset();
    expect(restarted.getSystem().compatibilityConfirmation).toBe('required');
    await expect(
      restarted.confirmCompatibility({ ...input, clientOperationId: operationId() }),
    ).rejects.toMatchObject({ code: 'COMPATIBILITY_CHANGED' });
  });

  it.each(['not-ready', 'unavailable', 'unknown-version'] as const)(
    'cannot override a %s runtime with consent',
    async (state) => {
      const ctx = setup();
      unverified(ctx);
      const input = confirmation(ctx);
      if (state === 'not-ready') ctx.codex.ready = false;
      if (state === 'unavailable') ctx.codex.compatibility = 'unavailable';
      if (state === 'unknown-version') ctx.codex.codexVersion = null;
      const dispatch = vi.spyOn(ctx.store, 'dispatch');
      await expect(ctx.service.confirmCompatibility(input)).rejects.toMatchObject({
        code: 'CODEX_UNAVAILABLE',
        status: 503,
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(ctx.service.getSystem().compatibilityConfirmation).not.toBe('confirmed');
    },
  );

  it('needs no consent for the verified version and retains reconciliation for an old ended execution', async () => {
    const ctx = setup();
    expect(ctx.service.getSystem().compatibilityConfirmation).toBe('not-required');
    const thread = await create(ctx);
    const operation = operationId();
    await ctx.service.startTurn(thread, { clientOperationId: operation, text: 'test' });
    ctx.codex.complete(thread, 'turn-1');
    unverified(ctx);
    expect(
      (
        await ctx.service.reconcileOperation(operation, {
          clientOperationId: operationId(),
          confirmEnded: true,
        })
      ).status,
    ).toBe('acknowledged');
    expect(ctx.service.getSystem().compatibilityConfirmation).toBe('required');
  });

  it('rechecks compatibility after an external history read before resuming', async () => {
    const ctx = setup();
    unverified(ctx);
    await ctx.service.confirmCompatibility(confirmation(ctx));
    const external = threadView('external', ctx.project);
    external.source = 'cli';
    const gate = deferred<ThreadView>();
    vi.spyOn(ctx.codex, 'readThread').mockReturnValueOnce(gate.promise);
    const pending = ctx.service.resumeThread(external.id, {
      clientOperationId: operationId(),
      confirmExternalStopped: true,
    });
    ctx.codex.verifiedVersion = 'new-baseline';
    gate.resolve(external);
    await expect(pending).rejects.toMatchObject({ code: 'COMPATIBILITY_CONFIRMATION_REQUIRED' });
    expect(ctx.codex.resumes).toBe(0);
  });

  it('rechecks compatibility after an external history read before forking', async () => {
    const ctx = setup();
    unverified(ctx);
    await ctx.service.confirmCompatibility(confirmation(ctx));
    const external = threadView('external', ctx.project);
    external.source = 'cli';
    const gate = deferred<ThreadView>();
    vi.spyOn(ctx.codex, 'readThread').mockReturnValueOnce(gate.promise);
    const dispatch = vi.spyOn(ctx.store, 'dispatch');
    const pending = ctx.service.forkThread(external.id, { clientOperationId: operationId() });
    ctx.codex.verifiedVersion = 'new-baseline';
    gate.resolve(external);
    await expect(pending).rejects.toMatchObject({ code: 'COMPATIBILITY_CONFIRMATION_REQUIRED' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.codex.forks).toBe(0);
    expect(ctx.service.projection.get(external.id)).toBeUndefined();
  });

  it.each(['start', 'steer', 'resolve'] as const)(
    'rechecks compatibility after asynchronous %s validation and before dispatch',
    async (kind) => {
      const ctx = setup();
      const threadId = await create(ctx);
      if (kind !== 'start')
        await ctx.service.startTurn(threadId, { clientOperationId: operationId(), text: 'run' });
      if (kind === 'resolve') approval(ctx, threadId);
      const view = await ctx.service.getThread(threadId);
      unverified(ctx);
      await ctx.service.confirmCompatibility(confirmation(ctx));
      const gate = deferred<ThreadView>();
      vi.spyOn(ctx.service, 'getThread').mockReturnValueOnce(gate.promise);
      const dispatch = vi.spyOn(ctx.store, 'dispatch');
      const id = operationId();
      const pending =
        kind === 'start'
          ? ctx.service.startTurn(threadId, { clientOperationId: id, text: 'run' })
          : kind === 'steer'
            ? ctx.service.steer(threadId, {
                clientOperationId: id,
                expectedTurnId: 'turn-1',
                text: 'extra',
              })
            : ctx.service.resolveAction('approval', {
                clientOperationId: id,
                resolution: { decision: 'accept' },
              });
      ctx.codex.codexVersion = 'another-version';
      gate.resolve(view);
      await expect(pending).rejects.toMatchObject({ code: 'COMPATIBILITY_CONFIRMATION_REQUIRED' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(ctx.store.get(id)?.state).toBe('failed');
      expect(ctx.codex.steers).toBe(0);
      expect(ctx.codex.replies).toBe(0);
    },
  );
});
