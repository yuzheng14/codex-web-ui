import type { ThreadSummary, ThreadView } from './types.js';

/** Overview messages deliberately omit conversation content and control payloads. */
export function toThreadSummary(thread: ThreadView): ThreadSummary {
  return {
    id: thread.id,
    ...(thread.archived === undefined ? {} : { archived: thread.archived }),
    ...(thread.forkedFromId === undefined ? {} : { forkedFromId: thread.forkedFromId }),
    projectId: thread.projectId,
    source: thread.source,
    title: thread.title,
    status: thread.status,
    managed: thread.managed,
    ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
    pendingActionCount: thread.actions.filter(
      (action) => action.status === 'pending' || action.status === 'responding',
    ).length,
    ...(thread.turns.at(-1) === undefined ? {} : { lastTurnStatus: thread.turns.at(-1)!.status }),
  };
}
