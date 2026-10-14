import { afterEach, describe, expect, it } from 'vitest';
import type { PendingAction } from '../../src/shared/types.js';
import { resolveActionSchema } from '../../src/shared/validation.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.close();
});
async function setup(kind: 'permissions' | 'elicitation') {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const threadId = (created.result as { threadId: string }).threadId;
  await ctx.service.startTurn(threadId, {
    clientOperationId: operationId(),
    text: 'approve explicitly',
  });
  const action: PendingAction = {
    actionId: 'interactive',
    codexEpoch: ctx.codex.epoch,
    rpcId: 0,
    kind,
    threadId,
    turnId: 'turn-1',
    status: 'pending',
    blocking: true,
    title: '需要确认',
    options: [
      { id: 'accept', label: '允许' },
      { id: 'decline', label: '拒绝' },
    ],
    ...(kind === 'permissions'
      ? { permissionRequest: { network: true } }
      : {
          elicitation: {
            serverName: 'test',
            mode: 'form' as const,
            fields: [
              {
                name: 'count',
                title: '次数',
                type: 'integer' as const,
                required: true,
                minimum: 0,
                maximum: 3,
              },
              { name: 'enabled', title: '启用', type: 'boolean' as const, required: true },
            ],
          },
        }),
  };
  ctx.codex.emit({ type: 'action', action });
  return { ...ctx, threadId, action };
}

describe('interactive approval claims', () => {
  it.each(['permissions', 'elicitation'] as const)(
    'keeps %s pending on disconnect or validation failure, then claims it only once',
    async (kind) => {
      const ctx = await setup(kind);
      const unsubscribe = await ctx.service.subscribe(ctx.threadId, undefined, () => {});
      unsubscribe();
      expect(ctx.codex.replies).toBe(0);
      expect(ctx.codex.stops).toBe(0);
      await expect(
        ctx.service.resolveAction(ctx.action.actionId, {
          clientOperationId: operationId(),
          resolution: { decision: 'accept', content: { count: '2', enabled: false } },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect((await ctx.service.getThread(ctx.threadId)).actions[0]?.status).toBe('pending');
      expect(ctx.codex.replies).toBe(0);
      ctx.codex.replyGate = deferred();
      const resolution =
        kind === 'permissions'
          ? { decision: 'accept' }
          : { decision: 'accept', content: { count: 0, enabled: false } };
      const accepted = ctx.service.resolveAction(ctx.action.actionId, {
        clientOperationId: operationId(),
        resolution,
      });
      await expect(
        ctx.service.resolveAction(ctx.action.actionId, {
          clientOperationId: operationId(),
          resolution: { decision: 'decline' },
        }),
      ).rejects.toMatchObject({ code: 'ACTION_CONFLICT' });
      expect(ctx.codex.replies).toBe(1);
      ctx.codex.replyGate.resolve();
      await accepted;
      expect((await ctx.service.getThread(ctx.threadId)).actions[0]?.status).toBe('responding');
      ctx.codex.emit({ type: 'actionResolved', actionId: ctx.action.actionId });
      expect((await ctx.service.getThread(ctx.threadId)).actions[0]?.status).toBe('responded');
    },
  );

  it.each(['permissions', 'elicitation'] as const)(
    'rejects stale %s approvals after runtime reset',
    async (kind) => {
      const ctx = await setup(kind);
      ctx.codex.reset();
      await expect(
        ctx.service.resolveAction(ctx.action.actionId, {
          clientOperationId: operationId(),
          resolution: { decision: 'decline' },
        }),
      ).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
      expect(ctx.codex.replies).toBe(0);
    },
  );

  it('rejects client-injected permission profiles and malformed form value types at the HTTP contract', () => {
    const clientOperationId = operationId();
    for (const resolution of [
      { decision: 'accept', permissions: { network: { enabled: true } } },
      { decision: 'accept', scope: 'session' },
      { decision: 'accept', content: { nested: { enabled: true } } },
      { decision: 'accept', content: { array: [1, 2] } },
      { decision: 'accept', content: { nullValue: null } },
    ])
      expect(resolveActionSchema.safeParse({ clientOperationId, resolution }).success).toBe(false);
    const content = { name: '截图', count: 0, enabled: false, tags: ['web'] };
    expect(
      resolveActionSchema.parse({ clientOperationId, resolution: { decision: 'accept', content } }),
    ).toEqual({
      clientOperationId,
      resolution: { decision: 'accept', content },
    });
  });
});
