import { afterEach, expect, it, vi } from 'vitest';
import type { ServerMessage, ThreadView } from '../../src/shared/types.js';
import { deferred, harness, operationId } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const ctx of resources.splice(0)) ctx.close();
});
it('refreshes settings from metadata and never replaces a newer live update with a late read', async () => {
  const ctx = harness();
  resources.push(ctx);
  const created = await ctx.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  const actual = ctx.codex.threads.get(id)!;
  actual.modelSettings = { model: 'model-a', reasoningEffort: 'low' };
  expect((await ctx.service.getThread(id)).modelSettings).toEqual(actual.modelSettings);
  const events: ServerMessage[] = [];
  await ctx.service.subscribe(id, undefined, (event) => events.push(event));
  const late = deferred<ThreadView>();
  vi.spyOn(ctx.codex, 'readThreadMetadata').mockReturnValueOnce(late.promise);
  const reading = ctx.service.getThread(id);
  await Promise.resolve();
  const settings = { model: 'model-b', reasoningEffort: 'high' };
  ctx.codex.emit({ type: 'threadSettings', threadId: id, settings });
  late.resolve(structuredClone(actual));
  expect((await reading).modelSettings).toEqual(settings);
  expect(events.at(-1)).toMatchObject({ kind: 'thread', payload: { modelSettings: settings } });
  ctx.service.projection.thread(actual, true);
  expect(ctx.service.projection.get(id)?.modelSettings).toEqual(settings);
});
