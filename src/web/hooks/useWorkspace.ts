import { useCallback, useEffect, useRef, useState } from 'react';
import type { Operation, Project, Settings, SystemInfo, ThreadView } from '../../shared/types';
import { api, HttpError } from '../lib/api';
import { isSettled, readOperations, saveOperations, type SavedOperation } from '../lib/operations';
import { ThreadStream, type ConnectionState } from '../lib/realtime';
import { readableError } from '../lib/utils';
import { operationNeedsCompatibilityConfirmation } from '../lib/compatibility';
import { SystemSnapshotGuard } from '../lib/system';

function preferredProject() {
  try {
    return localStorage.getItem('codex-web.project') ?? '';
  } catch {
    return '';
  }
}

export function useWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(preferredProject);
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadView>();
  const [selectedId, setSelectedId] = useState<string>();
  const selectedRef = useRef<string | undefined>(undefined);
  const [system, setSystem] = useState<SystemInfo>();
  const systemSnapshotGuard = useRef(new SystemSnapshotGuard());
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string>();
  const [errorDetails, setErrorDetails] = useState<unknown>();
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState<string[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [operations, setOperations] = useState<SavedOperation[]>(readOperations);
  const operationsRef = useRef(operations);
  const busyRef = useRef(new Set<string>());
  const streamRef = useRef<ThreadStream | undefined>(undefined);
  const projectRef = useRef(projectId);
  const [settings, setSettings] = useState<Settings>({});

  const report = useCallback((problem: unknown) => {
    setError(readableError(problem));
    setErrorDetails(problem instanceof HttpError ? problem.problem.details : undefined);
    if (problem instanceof HttpError && problem.authenticationRequired) setAuthRequired(true);
  }, []);
  const refreshSystem = useCallback(async () => {
    const read = systemSnapshotGuard.current.beginRead();
    try {
      const next = await api.system();
      if (systemSnapshotGuard.current.canApplyRead(read)) {
        setSystem(next);
        return next;
      }
    } catch (problem) {
      if (systemSnapshotGuard.current.canApplyRead(read)) report(problem);
    }
  }, [report]);
  const track = useCallback((update: (previous: SavedOperation[]) => SavedOperation[]) => {
    const next = update(operationsRef.current);
    operationsRef.current = next;
    setOperations(next);
    if (!saveOperations(next))
      setError('浏览器未允许保存操作记录。请保持此页面打开，以便核对未确认的提交。');
  }, []);
  const updateThread = useCallback(
    (next: ThreadView) => {
      if (next.id === selectedRef.current) setThread(next);
      setThreads((previous) =>
        next.projectId === projectRef.current
          ? [next, ...previous.filter((entry) => entry.id !== next.id)].sort(
              (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
            )
          : previous,
      );
      if (
        next.execution &&
        !next.execution.ended &&
        !operationsRef.current.some(
          (entry) => entry.clientOperationId === next.execution?.operationId,
        )
      ) {
        const execution = next.execution;
        // A new device can discover a durable execution without possessing the original browser storage.
        track((previous) => [
          ...previous,
          {
            clientOperationId: execution.operationId,
            kind: 'send',
            target: next.id,
            createdAt: Date.now(),
            status: 'unknown',
          },
        ]);
      }
    },
    [track],
  );
  const selectThread = useCallback(
    async (id: string) => {
      selectedRef.current = id;
      setSelectedId(id);
      setThread(streamRef.current?.cache.get(id)?.data);
      streamRef.current?.select(id);
      try {
        localStorage.setItem(`codex-web.selected:${projectRef.current}`, id);
      } catch {
        /* Preferences are optional. */
      }
      try {
        const loaded = await api.thread(id);
        if (selectedRef.current === id)
          updateThread(streamRef.current?.cache.get(id)?.data ?? loaded);
      } catch (problem) {
        if (selectedRef.current === id) report(problem);
      }
    },
    [report, updateThread],
  );
  const applyOperation = useCallback(
    (operation: Operation) => {
      const known = operationsRef.current.find(
        (entry) => entry.clientOperationId === operation.clientOperationId,
      );
      if (!known) return;
      track((previous) =>
        previous.map((entry) =>
          entry.clientOperationId === operation.clientOperationId
            ? { ...entry, status: operation.status, operation, error: operation.error?.message }
            : entry,
        ),
      );
      if (operation.status === 'failed') {
        setError(operation.error?.message ?? '操作失败，请查看详情。');
        setErrorDetails(operation.error?.details);
      }
      if (operation.status === 'acknowledged') {
        if (known.kind === 'confirmCompatibility') void refreshSystem();
        const result = operation.result as
          { threadId?: string; id?: string; thread?: { id?: string } } | undefined;
        const id =
          result?.threadId ??
          result?.thread?.id ??
          (known.kind === 'create' ? result?.id : undefined);
        if (known.kind === 'create' && known.target === projectRef.current && id)
          void selectThread(id);
      }
      if (isSettled(operation))
        track((previous) =>
          previous.filter((entry) => entry.clientOperationId !== operation.clientOperationId),
        );
    },
    [refreshSystem, selectThread, track],
  );

  const refreshOperations = useCallback(async () => {
    await Promise.all(
      operationsRef.current.map(async (entry) => {
        try {
          applyOperation(await api.operation(entry.clientOperationId));
        } catch (problem) {
          if (problem instanceof HttpError && problem.authenticationRequired) {
            report(problem);
            return;
          }
          track((previous) =>
            previous.map((current) =>
              current.clientOperationId === entry.clientOperationId
                ? { ...current, error: `无法确认提交：${readableError(problem)}` }
                : current,
            ),
          );
        }
      }),
    );
  }, [applyOperation, report, track]);
  const refreshThread = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    try {
      updateThread(await api.thread(id));
    } catch (problem) {
      report(problem);
    }
  }, [report, updateThread]);
  const loadThreads = useCallback(
    async (cursor?: string) => {
      const id = projectRef.current;
      if (!id) return;
      setLoadingThreads(true);
      try {
        const page = await api.threads(id, cursor);
        if (projectRef.current !== id) return;
        setThreads((previous) =>
          cursor
            ? [
                ...previous,
                ...page.data.filter(
                  (entry) => !previous.some((existing) => existing.id === entry.id),
                ),
              ]
            : page.data,
        );
        setNextCursor(page.nextCursor);
      } catch (problem) {
        if (projectRef.current === id) report(problem);
      } finally {
        if (projectRef.current === id) setLoadingThreads(false);
      }
    },
    [report],
  );

  useEffect(() => {
    let active = true;
    void api
      .projects()
      .then(({ data }) => {
        if (!active) return;
        setProjects(data);
        setProjectId((previous) =>
          data.some((project) => project.id === previous) ? previous : (data[0]?.id ?? ''),
        );
      })
      .catch(report);
    void refreshSystem();
    return () => {
      active = false;
    };
  }, [refreshSystem, report]);
  useEffect(() => {
    const stream = new ThreadStream({
      connection: (state) => {
        setConnection(state);
        if (state === 'connected') void refreshSystem();
      },
      thread: updateThread,
      system: (next) => {
        systemSnapshotGuard.current.runtimeEvent();
        setSystem(next);
      },
      operation: applyOperation,
      error: (message) => {
        setError(message);
        setErrorDetails(undefined);
      },
    });
    streamRef.current = stream;
    stream.start();
    if (selectedRef.current) stream.select(selectedRef.current);
    return () => {
      stream.stop();
      streamRef.current = undefined;
    };
  }, [applyOperation, refreshSystem, updateThread]);
  useEffect(() => {
    projectRef.current = projectId;
    selectedRef.current = undefined;
    setSelectedId(undefined);
    setThread(undefined);
    setThreads([]);
    setNextCursor(null);
    streamRef.current?.select(undefined);
    try {
      localStorage.setItem('codex-web.project', projectId);
    } catch {
      /* Preferences are optional. */
    }
    void loadThreads();
    try {
      const remembered = localStorage.getItem(`codex-web.selected:${projectId}`);
      if (projectId && remembered) void selectThread(remembered);
    } catch {
      /* A fresh snapshot is still used when no preference is available. */
    }
  }, [projectId, loadThreads, selectThread]);
  useEffect(() => {
    if (authRequired) {
      streamRef.current?.stop();
      setConnection('authenticationRequired');
    }
  }, [authRequired]);
  useEffect(() => {
    if (authRequired) return;
    void refreshOperations();
    const timer = setInterval(() => {
      void refreshOperations();
    }, 4_000);
    const systemTimer = setInterval(() => {
      void refreshSystem();
    }, 30_000);
    return () => {
      clearInterval(timer);
      clearInterval(systemTimer);
    };
  }, [authRequired, refreshOperations, refreshSystem]);

  const run = useCallback(
    async (kind: string, target: string, path: string, body: object = {}) => {
      if (operationNeedsCompatibilityConfirmation(kind, system)) {
        setError('请先确认当前 Codex 版本的兼容性提示，再发起操作。');
        setErrorDetails(undefined);
        return undefined;
      }
      const key = `${kind}:${target}`;
      if (busyRef.current.has(key)) return;
      busyRef.current.add(key);
      setBusy([...busyRef.current]);
      setError(undefined);
      setErrorDetails(undefined);
      const clientOperationId = crypto.randomUUID();
      track((previous) => [
        ...previous,
        { clientOperationId, kind, target, createdAt: Date.now(), status: 'accepted' },
      ]);
      try {
        const operation = await api.submit(path, { ...body, clientOperationId });
        applyOperation(operation);
        return operation;
      } catch (problem) {
        report(problem);
        if (
          problem instanceof HttpError &&
          problem.status >= 400 &&
          problem.status < 500 &&
          problem.status !== 408
        ) {
          track((previous) =>
            previous.filter((entry) => entry.clientOperationId !== clientOperationId),
          );
          return undefined;
        }
        track((previous) =>
          previous.map((entry) =>
            entry.clientOperationId === clientOperationId
              ? { ...entry, status: 'unknown', error: readableError(problem) }
              : entry,
          ),
        );
        // Query the same operation identity. Never automatically resend an uncertain intent.
        try {
          const recovered = await api.operation(clientOperationId);
          applyOperation(recovered);
          if (recovered.status === 'acknowledged') {
            setError((previous) => (previous === readableError(problem) ? undefined : previous));
            return recovered;
          }
        } catch {
          /* Remains visible for explicit reconciliation. */
        }
        return undefined;
      } finally {
        busyRef.current.delete(key);
        setBusy([...busyRef.current]);
      }
    },
    [applyOperation, report, track, system],
  );

  return {
    projects,
    projectId,
    setProjectId,
    threads,
    nextCursor,
    thread,
    selectedId,
    selectThread,
    system,
    connection,
    error,
    errorDetails,
    clearError: () => {
      setError(undefined);
      setErrorDetails(undefined);
    },
    authRequired: authRequired || connection === 'authenticationRequired',
    busy,
    loadingThreads,
    operations,
    settings,
    setSettings,
    run,
    loadThreads,
    refreshThread,
    refreshSystem,
    refreshOperations,
    retryConnection: () => streamRef.current?.retry(),
  };
}
