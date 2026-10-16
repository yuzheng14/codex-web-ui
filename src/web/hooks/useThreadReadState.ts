import { useCallback, useEffect, useReducer, useState } from 'react';
import type { ThreadSummary } from '../../shared/types';
import { COMPLETION_READ_PREFIX, completedTurnId, CompletionReads } from '../lib/thread-read-state';

export function useThreadReadState() {
  const [reads] = useState(() => new CompletionReads());
  const [, refresh] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(COMPLETION_READ_PREFIX)) return;
      reads.invalidate(event.key);
      refresh();
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [reads]);
  const markCompletedRead = useCallback(
    (threadId: string, turnId: string) => {
      if (reads.markRead(threadId, turnId)) refresh();
    },
    [reads],
  );
  const isUnreadCompletion = (thread: ThreadSummary) => {
    const turnId = completedTurnId(thread);
    return Boolean(turnId && !reads.isRead(thread.id, turnId));
  };
  return { isUnreadCompletion, markCompletedRead };
}
