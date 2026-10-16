import type { ItemView, RunStatus, TurnView } from '../shared/types.js';

const active = (status: RunStatus) =>
  status === 'running' || status === 'waitingApproval' || status === 'waitingInput';

/** History has no item lifecycle field. Never let a history read erase a live observation. */
export function mergeCompaction(item: ItemView, previous?: ItemView): ItemView {
  if (item.type !== 'contextCompaction' || !previous) return item;
  if (
    !item.status ||
    (item.status === 'inProgress' && previous.status && previous.status !== 'inProgress')
  )
    return {
      ...item,
      status: previous.status,
      ...(previous.error ? { error: previous.error } : {}),
    };
  // An item/completed envelope cannot reverse a preceding explicit compaction failure.
  if (previous.status === 'failed' || previous.status === 'interrupted') return previous;
  return item;
}

/** Only live item/started proves ongoing compaction; a terminal turn cannot leave it spinning. */
export function settleCompactions(turn: TurnView): void {
  for (const item of turn.items) {
    if (item.type !== 'contextCompaction') continue;
    if (!item.status) {
      // Old successful turns retain completion records, but an active/failed history alone
      // cannot establish whether its compaction succeeded or is still running.
      if (turn.status === 'completed') item.status = 'completed';
      continue;
    }
    if (item.status !== 'inProgress' || active(turn.status)) continue;
    item.status =
      turn.status === 'failed' || turn.status === 'interrupted' ? turn.status : 'unknown';
    if (turn.error) item.error = turn.error.slice(0, 4096);
  }
}

export function endCompactions(turn: TurnView, status: string, error?: string): boolean {
  let changed = false;
  for (const item of turn.items) {
    if (item.type !== 'contextCompaction' || item.status !== 'inProgress') continue;
    item.status = status;
    if (error) item.error = error.slice(0, 4096);
    changed = true;
  }
  return changed;
}
