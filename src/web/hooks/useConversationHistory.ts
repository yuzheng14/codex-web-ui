import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadView } from '../../shared/types';
import { api } from '../lib/api';
import { HistoryWindow } from '../lib/thread-history';
import { readableError } from '../lib/utils';

export function useConversationHistory(
  thread: ThreadView | undefined,
  selectedId: string | undefined,
) {
  const windowRef = useRef<HistoryWindow | undefined>(undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  const [state, setState] = useState<{
    id?: string;
    thread?: ThreadView;
    loading: boolean;
    error?: string;
  }>({ loading: false });
  const publish = useCallback((loading = false, error?: string) => {
    setState({ id: windowRef.current?.latest.id, thread: windowRef.current?.view, loading, error });
  }, []);
  useEffect(() => {
    if (windowRef.current?.latest.id !== selectedId) {
      pending.current?.abort();
      pending.current = undefined;
      windowRef.current = undefined;
      setState({ id: selectedId, loading: false });
    }
    return () => {
      pending.current?.abort();
    };
  }, [selectedId]);
  useEffect(() => {
    if (!thread || thread.id !== selectedId) return;
    if (windowRef.current?.latest.id === thread.id) windowRef.current.update(thread);
    else windowRef.current = new HistoryWindow(thread);
    publish(Boolean(pending.current));
  }, [thread, selectedId, publish]);
  const loadOlder = useCallback(async () => {
    const window = windowRef.current;
    const cursor = window?.cursor;
    if (!window || !cursor || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    publish(true);
    try {
      const page = await api.threadHistory(
        window.latest.id,
        cursor,
        AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]),
      );
      if (controller.signal.aborted || windowRef.current !== window) return;
      window.append(cursor, page);
      publish();
    } catch (problem) {
      if (!controller.signal.aborted && windowRef.current === window)
        publish(false, readableError(problem));
    } finally {
      if (pending.current === controller) pending.current = undefined;
    }
  }, [publish]);
  return { ...state, thread: state.id === selectedId ? state.thread : undefined, loadOlder };
}
