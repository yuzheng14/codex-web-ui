import { useCallback, useEffect, useRef, useState } from 'react';
import { shellActive, type ShellCommand, type ShellSnapshot } from '../../shared/shell';
import type { Operation } from '../../shared/types';
import { HttpError, request } from '../lib/api';

/** HTTP polling shares the gateway's authentication and Origin checks. */
export function useShell(visible: boolean) {
  const [commands, setCommands] = useState<ShellCommand[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<{ id: string; projectId: string; command: string }>();
  const [submitting, setSubmitting] = useState(false);
  const [interrupting, setInterrupting] = useState<string>();
  const cursor = useRef<{ epoch?: string; revision: number }>({ revision: 0 });
  const reconcile = useRef(pending);
  reconcile.current = pending;
  const pollDelay = useRef(5000);
  pollDelay.current = visible || commands.some(shellActive) || pending ? 500 : 5000;
  const merge = useCallback((incoming: ShellCommand[], reset = false) => {
    setCommands((previous) => {
      const entries = new Map(
        previous.map((entry) => [
          entry.id,
          reset && shellActive(entry)
            ? {
                ...entry,
                status: 'unknown' as const,
                error: '服务已重启，无法恢复执行状态；已收到的输出已保留。',
              }
            : entry,
        ]),
      );
      for (const entry of incoming) {
        const existing = entries.get(entry.id);
        if (!existing || reset || existing.revision <= entry.revision) entries.set(entry.id, entry);
      }
      return [...entries.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
    });
  }, []);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const current = cursor.current;
      const query = new URLSearchParams({
        after: String(current.revision),
        ...(current.epoch ? { epoch: current.epoch } : {}),
      });
      const snapshot = await request<ShellSnapshot>(
        `/api/shell?${query}`,
        undefined,
        signal ?? AbortSignal.timeout(5000),
      );
      if (signal?.aborted) return;
      const reset = Boolean(current.epoch && current.epoch !== snapshot.epoch);
      if (snapshot.commands.length || reset) merge(snapshot.commands, reset);
      cursor.current = { epoch: snapshot.epoch, revision: snapshot.revision };
      setConnected(true);
      const uncertain = reconcile.current;
      if (uncertain) {
        const restored = snapshot.commands.find((entry) => entry.id === uncertain.id);
        if (restored) {
          setPending(undefined);
          setError(undefined);
          return;
        }
        let op: Operation;
        try {
          op = await request<Operation>(`/api/operations/${uncertain.id}`, undefined, signal);
        } catch {
          return;
        }
        if (op.status === 'acknowledged') {
          const run = (op.result as { shellCommand?: ShellCommand })?.shellCommand;
          if (run && !snapshot.commands.some((entry) => entry.id === run.id)) {
            // The durable receipt can outlive the in-memory output history. Never resend it.
            merge([
              {
                ...run,
                status: 'unknown',
                error: '执行已提交；记录已过期或服务已重启，请检查服务端结果。',
              },
            ]);
          }
          setPending(undefined);
          setError(undefined);
        } else if (op.status === 'failed') {
          setPending(undefined);
          setError(op.error?.message ?? '命令未能启动');
        }
      }
    },
    [merge],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
      } catch {
        if (!controller.signal.aborted) setConnected(false);
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void poll();
        }, pollDelay.current);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh, visible]);
  const execute = async (projectId: string, command: string) => {
    if (pending || submitting) return false;
    const id = crypto.randomUUID();
    setSubmitting(true);
    setError(undefined);
    try {
      const op = await request<Operation>(`/api/projects/${encodeURIComponent(projectId)}/shell`, {
        clientOperationId: id,
        command,
      });
      if (op.status === 'acknowledged') {
        merge([(op.result as { shellCommand: ShellCommand }).shellCommand]);
        return true;
      }
      if (op.status === 'failed') {
        setError(op.error?.message ?? '命令未能启动');
        return false;
      }
      setPending({ id, projectId, command });
    } catch (failure) {
      if (failure instanceof HttpError && failure.status >= 400 && failure.status < 500) {
        setError(failure.message);
        return false;
      }
      // A lost response is not evidence that the command did not start.
      setPending({ id, projectId, command });
      setError('提交结果未确认，正在核对；请勿重复执行。');
    } finally {
      setSubmitting(false);
    }
    return false;
  };
  const retry = async () => {
    if (!pending || submitting) return;
    setSubmitting(true);
    try {
      const op = await request<Operation>(
        `/api/projects/${encodeURIComponent(pending.projectId)}/shell`,
        { clientOperationId: pending.id, command: pending.command },
      );
      if (op.status === 'acknowledged') {
        setPending(undefined);
        setError(undefined);
        cursor.current = { revision: 0 };
      } else if (op.status === 'failed') {
        setPending(undefined);
        setError(op.error?.message ?? '命令未能启动');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '提交仍未确认');
    } finally {
      setSubmitting(false);
    }
  };
  const interrupt = async (id: string) => {
    setInterrupting(id);
    setError(undefined);
    try {
      const op = await request<Operation>(`/api/shell/${encodeURIComponent(id)}/interrupt`, {
        clientOperationId: crypto.randomUUID(),
      });
      if (op.status !== 'acknowledged')
        setError(op.error?.message ?? '中断结果尚未确认，请刷新后核对');
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '中断失败，请重试');
    } finally {
      setInterrupting(undefined);
    }
  };
  return {
    commands,
    connected,
    error,
    pending,
    submitting,
    interrupting,
    execute,
    interrupt,
    retry,
  };
}
