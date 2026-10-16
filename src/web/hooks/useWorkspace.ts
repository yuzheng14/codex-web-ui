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
import { pendingSettings } from '../lib/settings';
import {
  blocksTarget,
  canDiscardMissingOperation,
  isSettled,
  operationLookupError,
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
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const projectsLoadedRef = useRef(false);
  const projectRevision = useRef(0);
  const projectReadSequence = useRef(0);
  const [projectId, setActiveProjectId] = useState(preferredProject);
  const projectsRef = useRef<Project[]>([]);
  const projectStore = useRef(new ProjectThreadsStore());
  const [archiveView, setArchiveView] = useState(false);
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
  const [settingsByScope, setSettingsByScope] = useState(settingsRef.current);
  const navigationRevision = useRef(0);
  const detailReadSequence = useRef(0);
  const getProjectSettings = useCallback(
    (id: string) => settingsRef.current[`project:${id}`] ?? {},
    [],
  );
  const setSettings = useCallback((next: Settings) => {
    const scope = selectedRef.current
      ? `thread:${selectedRef.current}`
      : `project:${projectRef.current}`;
    settingsRef.current = { ...settingsRef.current, [scope]: next };
    setSettingsByScope(settingsRef.current);
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
      if (!id || !projectsRef.current.some((project) => project.id === id)) return;
      const read = projectStore.current.beginRead(id, Boolean(cursor));
      setProjectThreads(projectStore.current.snapshot);
      try {
        const page = await api.threads(id, cursor, projectStore.current.archived);
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
  const changeArchiveView = useCallback(
    (archived: boolean) => {
      if (!projectStore.current.setArchived(archived)) return;
      setArchiveView(archived);
      setProjectThreads(projectStore.current.snapshot);
      void refreshProjectsThreads();
    },
    [refreshProjectsThreads],
  );
  const updateSummary = useCallback((summary: ThreadSummary, cursor: Cursor) => {
    if (!projectsRef.current.some((project) => project.id === summary.projectId)) return;
    if (projectStore.current.applySummary(summary, cursor))
      setProjectThreads(projectStore.current.snapshot);
  }, []);
  const updateThread = useCallback(
    (next: ThreadView) => {
      if (!projectsRef.current.some((project) => project.id === next.projectId)) return;
      if (next.id === selectedRef.current && next.projectId === projectRef.current) {
        setThread(next);
        changeArchiveView(Boolean(next.archived));
      }
      const scope = `thread:${next.id}`;
      const draft = settingsRef.current[scope];
      if (draft && next.runtimeSettings) {
        const pending = pendingSettings(draft, next.runtimeSettings);
        if (Object.keys(pending).length !== Object.keys(draft).length) {
          settingsRef.current = { ...settingsRef.current, [scope]: pending };
          setSettingsByScope(settingsRef.current);
        }
      }
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
    [track, changeArchiveView],
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
      if (!projectsRef.current.some((entry) => entry.id === project)) return;
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
  const applyProjects = useCallback(
    (data: Project[]) => {
      const ids = new Set(data.map((entry) => entry.id));
      const removed = projectsRef.current.filter((entry) => !ids.has(entry.id));
      if (removed.length > 0) {
        if (!ids.has(projectRef.current)) {
          navigationRevision.current++;
          detailReadSequence.current++;
        }
        for (const project of removed) {
          projectStore.current.removeProject(project.id);
          streamRef.current?.cache.removeProject(project.id);
        }
        setProjectThreads(projectStore.current.snapshot);
      }
      const added = data.filter(
        (entry) =>
          entry.available && !projectsRef.current.some((project) => project.id === entry.id),
      );
      projectsRef.current = data;
      setProjects(data);
      const preferred = projectRef.current;
      if (!projectsLoadedRef.current || !ids.has(preferred)) {
        selectProject(
          ids.has(preferred)
            ? preferred
            : (data.find((entry) => entry.available)?.id ?? data[0]?.id ?? ''),
        );
      }
      projectsLoadedRef.current = true;
      setProjectsLoaded(true);
      for (const project of added) void loadProjectThreads(project.id);
    },
    [loadProjectThreads, selectProject],
  );
  const refreshProjects = useCallback(async () => {
    const sequence = ++projectReadSequence.current;
    const revision = projectRevision.current;
    try {
      const { data } = await api.projects();
      if (sequence === projectReadSequence.current && revision === projectRevision.current)
        applyProjects(data);
    } catch (problem) {
      if (sequence === projectReadSequence.current && revision === projectRevision.current)
        report(problem);
    }
  }, [applyProjects, report]);
  const applyOperation = useCallback(
    (operation: Operation) => {
      const known = operationsRef.current.find(
        (entry) => entry.clientOperationId === operation.clientOperationId,
      );
      if (!known) return;
      if (known.lookupError)
        setError((previous) => (previous === known.lookupError?.message ? undefined : previous));
      track((previous) =>
        previous.map((entry) =>
          entry.clientOperationId === operation.clientOperationId
            ? {
                ...entry,
                status: operation.status,
                operation,
                error: operation.error?.message,
                lookupError: undefined,
              }
            : entry,
        ),
      );
      if (operation.status === 'failed' && operation.error?.code !== 'THREAD_IN_USE') {
        setError(operation.error?.message ?? '操作失败，请查看详情。');
        setErrorDetails(operation.error?.details);
      }
      if (operation.status === 'acknowledged') {
        // Recovery can finish before the initial project list restores the selected thread.
        // Keep the durable navigation intent until that selection can be checked safely.
        if (
          !projectsLoadedRef.current &&
          known.navigateToResult &&
          (known.kind === 'create' || known.kind === 'fork')
        )
          return;
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

  useEffect(() => {
    if (!projectsLoaded) return;
    for (const entry of operationsRef.current) {
      if (entry.operation?.status === 'acknowledged') applyOperation(entry.operation);
    }
  }, [projectsLoaded, applyOperation]);

  const recordLookupError = useCallback(
    (entry: SavedOperation, problem: unknown) => {
      const lookupError = operationLookupError(problem);
      let applied = false;
      track((previous) =>
        previous.map((current) => {
          // A late failed read must not overwrite a receipt received through POST or WebSocket.
          if (
            current.clientOperationId !== entry.clientOperationId ||
            current.operation !== entry.operation
          )
            return current;
          applied = true;
          return { ...current, lookupError };
        }),
      );
      return applied ? lookupError.message : undefined;
    },
    [track],
  );
  const refreshOperations = useCallback(
    async (reportErrors = false) => {
      const failures: string[] = [];
      await Promise.all(
        operationsRef.current.map(async (entry) => {
          // A browser identity is saved before POST; it may not have reached the gateway yet.
          if (busyRef.current.has(`${entry.kind}:${entry.target}`)) return;
          try {
            applyOperation(await api.operation(entry.clientOperationId));
          } catch (problem) {
            if (problem instanceof HttpError && problem.authenticationRequired) {
              report(problem);
              return;
            }
            const message = recordLookupError(entry, problem);
            if (message) failures.push(message);
          }
        }),
      );
      const currentFailures = failures.filter((message) =>
        operationsRef.current.some((entry) => entry.lookupError?.message === message),
      );
      if (reportErrors && currentFailures.length)
        report(new Error([...new Set(currentFailures)].join('\n')));
    },
    [applyOperation, report, recordLookupError],
  );
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
    void refreshProjects();
    void refreshSystem();
    return () => {
      projectReadSequence.current++;
    };
  }, [refreshSystem, refreshProjects]);
  useEffect(() => {
    const stream = new ThreadStream({
      connection: (state) => {
        setConnection(state);
        if (state === 'connected') {
          void refreshSystem();
          void refreshProjects().then(refreshProjectsThreads);
        }
      },
      thread: updateThread,
      summary: updateSummary,
      system: (next) => {
        systemSnapshotGuard.current.runtimeEvent();
        setSystem(next);
      },
      projects: (next) => {
        projectRevision.current++;
        applyProjects(next);
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
  }, [
    applyOperation,
    refreshSystem,
    updateThread,
    updateSummary,
    refreshProjectsThreads,
    refreshProjects,
    applyProjects,
  ]);
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
        if (!(problem instanceof HttpError && problem.problem.code === 'THREAD_IN_USE'))
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
        const entry = operationsRef.current.find(
          (current) => current.clientOperationId === clientOperationId,
        );
        try {
          const recovered = await api.operation(clientOperationId);
          applyOperation(recovered);
          if (recovered.status === 'acknowledged') {
            setError((previous) => (previous === readableError(problem) ? undefined : previous));
            return recovered;
          }
        } catch (lookupProblem) {
          if (lookupProblem instanceof HttpError && lookupProblem.authenticationRequired)
            report(lookupProblem);
          else if (entry) {
            const message = recordLookupError(entry, lookupProblem);
            if (message) report(new Error(message));
          }
        }
        return undefined;
      } finally {
        busyRef.current.delete(key);
        setBusy([...busyRef.current]);
      }
    },
    [applyOperation, report, track, system, recordLookupError],
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
    projectsLoaded,
    addProject: async (input: { path: string; name?: string }) => {
      projectRevision.current++;
      try {
        const added = await api.addProject(input);
        await refreshProjects();
        if (projectsRef.current.some((entry) => entry.id === added.id)) {
          cancelResultNavigation();
          selectProject(added.id);
        }
      } catch (problem) {
        if (problem instanceof HttpError && problem.authenticationRequired) report(problem);
        throw problem;
      }
    },
    renameProject: async (id: string, name: string) => {
      projectRevision.current++;
      try {
        await api.renameProject(id, name);
        await refreshProjects();
      } catch (problem) {
        if (problem instanceof HttpError && problem.authenticationRequired) report(problem);
        throw problem;
      }
    },
    removeProject: async (id: string) => {
      projectRevision.current++;
      try {
        await api.removeProject(id);
        await refreshProjects();
      } catch (problem) {
        if (problem instanceof HttpError && problem.authenticationRequired) report(problem);
        throw problem;
      }
    },
    projectId,
    setProjectId: (id: string) => {
      cancelResultNavigation();
      selectProject(id);
    },
    archiveView,
    setArchiveView: (archived: boolean) => {
      if (archived === projectStore.current.archived) return;
      cancelResultNavigation();
      selectedRef.current = undefined;
      setSelectedId(undefined);
      setThread(undefined);
      streamRef.current?.select(undefined);
      delete selectionsRef.current[projectRef.current];
      try {
        localStorage.removeItem(`codex-web.selected:${projectRef.current}`);
      } catch {
        /* Optional preference. */
      }
      changeArchiveView(archived);
    },
    archiveThread: async (id: string, archived: boolean) => {
      await run('archive', id, `/api/threads/${encodeURIComponent(id)}/archive`, { archived });
      await Promise.all([refreshThread(), refreshProjectsThreads()]);
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
    settings: settingsByScope[selectedId ? `thread:${selectedId}` : `project:${projectId}`] ?? {},
    setSettings,
    getProjectSettings,
    run,
    loadThreads,
    loadProjectThreads,
    refreshProjectsThreads,
    refreshProjects,
    refreshThread,
    refreshSystem,
    refreshOperations,
    discardMissingOperation: (id: string) => {
      const entry = operationsRef.current.find((current) => current.clientOperationId === id);
      if (
        !entry ||
        !canDiscardMissingOperation(entry) ||
        busyRef.current.has(`${entry.kind}:${entry.target}`)
      )
        return;
      track((previous) => previous.filter((current) => current.clientOperationId !== id));
      setError((previous) => (previous === entry.lookupError?.message ? undefined : previous));
    },
    retryConnection: () => streamRef.current?.retry(),
  };
}
