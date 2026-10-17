import type { ThreadSummary } from '../../shared/types';

export const COMPLETION_READ_PREFIX = 'codex-web.read-completion:';

export function completedTurnId(thread: ThreadSummary): string | undefined {
  const completed =
    (thread.status === 'completed' || thread.status === 'idle') &&
    thread.lastTurnStatus === 'completed';
  return completed ? thread.lastTurnId : undefined;
}

function readKey(threadId: string, turnId: string) {
  return `${COMPLETION_READ_PREFIX}${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`;
}

/** Per-turn receipts prevent an older tab from overwriting a newer turn's read state. */
export class CompletionReads {
  private readonly memory = new Set<string>();

  constructor(
    private readonly storage = (): Pick<Storage, 'getItem' | 'setItem'> => localStorage,
  ) {}

  isRead(threadId: string, turnId: string): boolean {
    const key = readKey(threadId, turnId);
    if (this.memory.has(key)) return true;
    try {
      return this.storage().getItem(key) === '1';
    } catch {
      return false;
    }
  }

  markRead(threadId: string, turnId: string): boolean {
    if (this.isRead(threadId, turnId)) return false;
    const key = readKey(threadId, turnId);
    this.memory.add(key);
    try {
      this.storage().setItem(key, '1');
    } catch {
      // Reading still works for this page when browser storage is unavailable or full.
    }
    return true;
  }

  invalidate(key: string | null) {
    if (key === null) this.memory.clear();
    else this.memory.delete(key);
  }
}
