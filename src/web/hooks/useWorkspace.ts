import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Cursor,
  Operation,
  Project,
  Settings,
  SystemInfo,
  ThreadSummary,
  ThreadView,
} from '../../shared/types';
import { api, HttpError } from '../lib/api';
import {
  blocksTarget,
  isSettled,
  readOperations,
  saveOperations,
  type SavedOperation,
} from '../lib/operations';
import { ThreadStream, type ConnectionState } from '../lib/realtime';
import { readableError } from '../lib/utils';
import { operationNeedsCompatibilityConfirmation } from '../lib/compatibility';
import { SystemSnapshotGuard } from '../lib/system';
import { ProjectThreadsStore } from '../lib/project-threads';

function preferredProject() {
  try {
    return localStorage.getItem('codex-web.project') ?? '';
  } catch {
    return '';
  }
}

export function useWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setActiveProjectId] = useState(preferredProject);
  const projectsRef = useRef<Project[]>([]);
  const projectStore = useRef(new ProjectThreadsStore());
  const [projectThreads, setProjectThreads] = useState(projectStore.current.snapshot);
  const [thread, setThread] = useState<ThreadView>();
  const [selectedId, setSelectedId] = useState<string>();
  const selectedRef = useRef<string | undefined>(undefined);
  const selectionsRef = useRef<Record<string, string>>({});
  const [system, setSystem] = useState<SystemInfo>();
  const systemSnapshotGuard = useRef(new SystemSnapshotGuard());
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string>();
  const [errorDetails, setErrorDetails] = useState<unknown>();
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState<string[]>([]);
  const [operations, setOperations] = useState<SavedOperation[]>(readOperations);
  const operationsRef = useRef(operations);
  const busyRef = useRef(new Set<string>());
  const streamRef = useRef<ThreadStream | undefined>(undefined);
  const projectRef = useRef(projectId);
  const settingsRef = useRef<Record<string, Settings>>({});
  const [settingsByProject, setSettingsByProject] = useState(settingsRef.current);
  const navigationRevision = useRef(0);
  const detailReadSequence = useRef(0);
  const getProjectSettings = useCallback((id: string) => settingsRef.current[id] ?? {}, []);
  const setSettings = useCallback((next: Settings) => {
    settingsRef.current = { ...settingsRef.current, [projectRef.current]: next };
    setSettingsByProject(settingsRef.current);
  }, []);

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
  const loadProjectThreads = useCallback(
    async (id: string, cursor?: string) => {
      if (!id) return;
      const read = projectStore.current.beginRead(id, Boolean(cursor));
      setProjectThreads(projectStore.current.snapshot);
      try {
        const page = await api.threads(id, cursor);
        if (projectStore.current.finishRead(read, page))
          setProjectThreads(projectStore.current.snapshot);
      } catch (problem) {
        if (projectStore.current.failRead(read, readableError(problem)))
          setProjectThreads(projectStore.current.snapshot);
        if (problem instanceof HttpError && problem.authenticationRequired) report(problem);
      }
    },
    [report],
  );
  const refreshProjectsThreads = useCallback(
    () =>
      Promise.all(
        projectsRef.current
          .filter((entry) => entry.available)
          .map((entry) => loadProjectThreads(entry.id)),
      ),
    [loadProjectThreads],
  );
  const updateSummary = useCallback((summary: ThreadSummary, cursor: Cursor) => {
    if (projectStore.current.applySummary(summary, cursor))
      setProjectThreads(projectStore.current.snapshot);
  }, []);
  const updateThread = useCallback(
    (next: ThreadView) => {
      if (next.id === selectedRef.current && next.projectId === projectRef.current) setThread(next);
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
  const activateProject = useCallback((id: string) => {
    // Change ownership synchronously, before any callbacks can issue project-scoped requests.
    projectRef.current = id;
    setActiveProjectId(id);
    try {
      localStorage.setItem('codex-web.project', id);
    } catch {
      /* Preferences are optional. */
    }
  }, []);
  const selectThread = useCallback(
    async (id: string, owningProjectId?: string) => {
      const revision = navigationRevision.current;
      const read = ++detailReadSequence.current;
      let project =
        owningProjectId ??
        projectStore.current.findProject(id) ??
        streamRef.current?.cache.get(id)?.data.projectId;
      let loaded: ThreadView | undefined;
      if (!project) {
        // Parent links may point outside the loaded list. Resolve ownership before navigation.
        try {
          loaded = await api.thread(id);
          if (navigationRevision.current !== revision || detailReadSequence.current !== read)
            return;
          project = loaded.projectId;
        } catch (problem) {
          if (navigationRevision.current === revision && detailReadSequence.current === read)
            report(problem);
          return;
        }
      }
      activateProject(project);
      selectedRef.current = id;
      selectionsRef.current[project] = id;
      setSelectedId(id);
      const cached = streamRef.current?.cache.get(id)?.data;
      setThread(cached?.projectId === project ? cached : loaded);
      streamRef.current?.select(id);
      try {
        localStorage.setItem(`codex-web.selected:${project}`, id);
      } catch {
        /* Preferences are optional. */
      }
      try {
        loaded ??= await api.thread(id);
        if (
          selectedRef.current !== id ||
          projectRef.current !== project ||
          navigationRevision.current !== revision ||
          detailReadSequence.current !== read
        )
          return;
        const latest = streamRef.current?.cache.get(id)?.data;
        updateThread(latest && latest !== cached ? latest : loaded);
      } catch (problem) {
        if (
          selectedRef.current === id &&
          projectRef.current === project &&
          navigationRevision.current === revision &&
          detailReadSequence.current === read
        )
          report(problem);
      }
    },
    [activateProject, report, updateThread],
  );
  const selectProject = useCallback(
    (id: string) => {
      activateProject(id);
      let remembered = selectionsRef.current[id];
      try {
        remembered ??= localStorage.getItem(`codex-web.selected:${id}`) ?? undefined;
      } catch {
        /* In-memory selections still work when storage is unavailable. */
      }
      if (id && remembered) {
        void selectThread(remembered, id);
        return;
      }
      selectedRef.current = undefined;
      setSelectedId(undefined);
      setThread(undefined);
      streamRef.current?.select(undefined);
    },
    [activateProject, selectThread],
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
        if ((known.kind === 'create' || known.kind === 'fork') && id) {
          const project = known.projectId ?? (known.kind === 'create' ? known.target : undefined);
          if (project) void loadProjectThreads(project);
          if (
            known.navigateToResult &&
            project === projectRef.current &&
            (known.kind === 'create' || known.target === selectedRef.current)
          ) {
            void selectThread(id, project);
          }
        }
      }
      if (isSettled(operation))
        track((previous) =>
          previous.filter((entry) => entry.clientOperationId !== operation.clientOperationId),
        );
    },
    [refreshSystem, selectThread, track, loadProjectThreads],
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
    const revision = navigationRevision.current;
    const read = ++detailReadSequence.current;
    try {
      const cached = streamRef.current?.cache.get(id)?.data;
      const loaded = await api.thread(id);
      if (revision !== navigationRevision.current || detailReadSequence.current !== read) return;
      const latest = streamRef.current?.cache.get(id)?.data;
      updateThread(latest && latest !== cached ? latest : loaded);
    } catch (problem) {
      if (revision === navigationRevision.current && detailReadSequence.current === read)
        report(problem);
    }
  }, [report, updateThread]);
  const loadThreads = useCallback(
    (cursor?: string) => loadProjectThreads(projectRef.current, cursor),
    [loadProjectThreads],
  );

  useEffect(() => {
    let active = true;
    void api
      .projects()
      .then(({ data }) => {
        if (!active) return;
        projectsRef.current = data;
        setProjects(data);
        const preferred = projectRef.current;
        selectProject(
          data.some((project) => project.id === preferred)
            ? preferred
            : (data.find((project) => project.available)?.id ?? data[0]?.id ?? ''),
        );
        void refreshProjectsThreads();
      })
      .catch(report);
    void refreshSystem();
    return () => {
      active = false;
    };
  }, [refreshSystem, report, selectProject, refreshProjectsThreads]);
  useEffect(() => {
    const stream = new ThreadStream({
      connection: (state) => {
        setConnection(state);
        if (state === 'connected') {
          void refreshSystem();
          void refreshProjectsThreads();
        }
      },
      thread: updateThread,
      summary: updateSummary,
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
  }, [applyOperation, refreshSystem, updateThread, updateSummary, refreshProjectsThreads]);
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
      if (
        kind === 'fork' &&
        operationsRef.current.some((entry) => entry.kind === 'fork' && blocksTarget(entry, target))
      )
        return;
      busyRef.current.add(key);
      setBusy([...busyRef.current]);
      setError(undefined);
      setErrorDetails(undefined);
      const clientOperationId = crypto.randomUUID();
      track((previous) => [
        ...previous,
        {
          clientOperationId,
          kind,
          target,
          createdAt: Date.now(),
          status: 'accepted',
          ...(kind === 'fork' || kind === 'create'
            ? { projectId: kind === 'create' ? target : projectRef.current, navigateToResult: true }
            : {}),
        },
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
          problem.status !== 408 &&
          problem.problem.code !== 'RESULT_UNKNOWN'
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

  const cancelResultNavigation = () => {
    navigationRevision.current++;
    if (operationsRef.current.some((entry) => entry.navigateToResult))
      track((previous) =>
        previous.map((entry) =>
          entry.navigateToResult ? { ...entry, navigateToResult: false } : entry,
        ),
      );
  };

  return {
    projects,
    projectId,
    setProjectId: (id: string) => {
      cancelResultNavigation();
      selectProject(id);
    },
    projectThreads,
    threads: projectThreads[projectId]?.data ?? [],
    nextCursor: projectThreads[projectId]?.nextCursor ?? null,
    thread,
    selectedId,
    selectThread: (id: string, owningProjectId?: string) => {
      cancelResultNavigation();
      return selectThread(id, owningProjectId);
    },
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
    loadingThreads: projectThreads[projectId]?.loading ?? false,
    operations,
    settings: settingsByProject[projectId] ?? {},
    setSettings,
    getProjectSettings,
    run,
    loadThreads,
    loadProjectThreads,
    refreshProjectsThreads,
    refreshThread,
    refreshSystem,
    refreshOperations,
    retryConnection: () => streamRef.current?.retry(),
  };
}
