import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Pencil } from 'lucide-react';
import type { ThreadSummary } from '../shared/types';
import { useWorkspace } from './hooks/useWorkspace';
import { useThreadReadState } from './hooks/useThreadReadState';
import { Sidebar } from './components/Sidebar';
import { FilePreviewProvider } from './components/FilePreviewProvider';
import { Conversation } from './components/Conversation';
import { ThreadTitle } from './components/ThreadTitle';
import { Composer } from './components/Composer';
import { ActionCard } from './components/ActionCard';
import { ConnectionBadge, Diagnostics } from './components/Diagnostics';
import { isActive, Status } from './components/Status';
import { Icon } from './components/Icon';
import { Button } from './components/ui/button';
import { ControlHint } from './components/ControlHint';
import { blocksTarget } from './lib/operations';
import { createSlashCommands, type SlashCommandContext } from './lib/slash-commands';
import { downloadThreadExport } from './lib/thread-export';
import { encodeQuestionReplies } from '../shared/async-questions';
import { CompatibilityNotice } from './components/CompatibilityNotice';
import { ProjectDialog } from './components/ProjectDialog';
import { NotificationSettings } from './components/NotificationSettings';
import { GatewaySettings } from './components/GatewaySettings';
import { UpdateSettings } from './components/UpdateSettings';
import { useConversationHistory } from './hooks/useConversationHistory';
import { useUpdates } from './hooks/useUpdates';
import { useShell } from './hooks/useShell';
import { ShellPanel } from './components/ShellPanel';
import { shellActive } from '../shared/shell';
import { updateActive } from '../shared/updates';
import {
  canConfirmCompatibility,
  compatibilityConfirmationRequired,
  compatibilityConfirmationInput,
  compatibilityFingerprint,
} from './lib/compatibility';

const encode = encodeURIComponent;

function WorkspaceLayout({
  threadId,
  getHistoryCursor,
  children,
}: {
  threadId?: string;
  getHistoryCursor: (targetId: string) => string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <FilePreviewProvider threadId={threadId} getHistoryCursor={getHistoryCursor}>
        {children}
      </FilePreviewProvider>
    </div>
  );
}

export function App() {
  const workspace = useWorkspace();
  const [shellOpen, setShellOpen] = useState(false);
  const shell = useShell(shellOpen);
  const [shellCollapsed, setShellCollapsed] = useState(false);
  const updates = useUpdates();
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const { isUnreadCompletion, markCompletedRead } = useThreadReadState();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [gatewaySettingsOpen, setGatewaySettingsOpen] = useState(false);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 761px)');
    const closeMobileNavigation = () => {
      if (desktop.matches) setSidebarOpen(false);
    };
    desktop.addEventListener('change', closeMobileNavigation);
    return () => desktop.removeEventListener('change', closeMobileNavigation);
  }, []);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const statusCheck = useRef(false);
  const [projectDialog, setProjectDialog] = useState<
    { kind: 'add' } | { kind: 'manage'; id: string }
  >();
  const [checkingCompatibility, setCheckingCompatibility] = useState(false);
  const [compatibilityDialogOpen, setCompatibilityDialogOpen] = useState(false);
  const compatibilityAttempt = useRef(false);
  const project = workspace.projects.find((entry) => entry.id === workspace.projectId);
  const managedProject =
    projectDialog?.kind === 'manage'
      ? workspace.projects.find((entry) => entry.id === projectDialog.id)
      : undefined;
  useEffect(() => {
    if (projectDialog?.kind === 'manage' && !managedProject) setProjectDialog(undefined);
  }, [projectDialog, managedProject]);
  const openAddProject = () => {
    setSidebarOpen(false);
    setProjectDialog({ kind: 'add' });
  };
  const { thread, system } = workspace;
  const historyForbidden =
    workspace.authRequired ||
    Boolean(
      workspace.threadReadFailure &&
      workspace.threadReadFailure.id === workspace.selectedId &&
      [401, 403, 404].includes(workspace.threadReadFailure.status),
    );
  const history = useConversationHistory(thread, workspace.selectedId, {
    projectId: workspace.projectId,
    scope: workspace.cacheScope,
    forbidden: historyForbidden,
  });
  const resumeAttempt = useRef<string | undefined>(undefined);
  const canControl = Boolean(
    system?.ready &&
    system.authenticated !== false &&
    workspace.connection === 'connected' &&
    !workspace.authRequired,
  );
  const canOperate =
    canControl && Boolean(project?.available) && !compatibilityConfirmationRequired(system);
  const canConfirm = canConfirmCompatibility(system, workspace.connection, workspace.authRequired);
  const compatibilityTarget = compatibilityFingerprint(system) ?? '';
  const busyFor = (kind: string, target = thread?.id ?? '') =>
    workspace.busy.includes(`${kind}:${target}`);
  const unsettledFor = (target: string) =>
    workspace.operations.some((entry) => blocksTarget(entry, target));
  const activeTurn = thread?.turns.findLast((turn) => isActive(turn.status));
  const actions =
    thread?.actions.filter(
      (action) =>
        action.status === 'pending' ||
        action.status === 'responding' ||
        (action.kind === 'unsupported' && action.status === 'expired'),
    ) ?? [];
  const waitingForConfirmation = thread
    ? (unsettledFor(thread.id) && !busyFor('resume')) ||
      (thread.managed && thread.status === 'unknown') ||
      (thread.execution && !thread.execution.ended && thread.status === 'unknown')
    : !busyFor('create', workspace.projectId) && unsettledFor(workspace.projectId);
  const resumeBlocked = Boolean(
    thread &&
    (!canOperate ||
      thread.archived ||
      unsettledFor(thread.id) ||
      busyFor('resume') ||
      (thread.execution && !thread.execution.ended)),
  );
  const { run, refreshThread } = workspace;
  const resumeThread = useCallback(() => {
    if (!thread || resumeBlocked) return;
    resumeAttempt.current = `${system?.codexEpoch}:${thread.id}`;
    // Preserve the saved session settings; composer overrides apply when sending a task.
    void run('resume', thread.id, `/api/threads/${encode(thread.id)}/resume`).then(() =>
      refreshThread(),
    );
  }, [thread, resumeBlocked, system?.codexEpoch, run, refreshThread]);
  useEffect(() => {
    if (!system?.ready || thread?.archived) resumeAttempt.current = undefined;
    if (!thread || thread.managed || resumeBlocked) return;
    const key = `${system?.codexEpoch}:${thread.id}`;
    if (resumeAttempt.current !== key) resumeThread();
  }, [thread, system?.ready, system?.codexEpoch, resumeBlocked, resumeThread]);
  const pendingFork = Boolean(
    thread &&
    workspace.operations.some((entry) => entry.kind === 'fork' && blocksTarget(entry, thread.id)),
  );
  const supportsFork = system?.capabilities.includes('thread/fork') ?? false;
  const isForking = (id: string) =>
    busyFor('fork', id) ||
    workspace.operations.some((entry) => entry.kind === 'fork' && blocksTarget(entry, id));
  const forkDisabledReason = (
    entry: Pick<ThreadSummary, 'id' | 'projectId' | 'historyVisible'>,
  ) => {
    if (isForking(entry.id)) return '正在确认 Fork…请等待提交回执，暂时不能再次 Fork。';
    if (!supportsFork) return '当前 Codex 版本不支持 Fork 会话。';
    if (!canControl) return '连接恢复且 Codex 就绪后可 Fork 会话。';
    if (!workspace.projects.find((project) => project.id === entry.projectId)?.available)
      return '项目目录不可用，恢复后可 Fork 会话。';
    if (compatibilityConfirmationRequired(system)) return '请先确认当前 Codex 版本的兼容性。';
    if (entry.historyVisible === false || (entry.id === thread?.id && !thread.turns.length))
      return '发送首条消息后可 Fork 已保存的历史。';
    return undefined;
  };
  const forking = Boolean(thread && isForking(thread.id));
  const canFork = Boolean(thread?.turns.length && !forkDisabledReason(thread));
  const forkConversation = async (
    entry: Pick<ThreadSummary, 'id' | 'projectId' | 'historyVisible'>,
  ) => {
    if (forkDisabledReason(entry)) return;
    // Only the selected conversation has composer overrides. Other rows inherit their source settings.
    return workspace.run(
      'fork',
      entry.id,
      `/api/threads/${encode(entry.id)}/fork`,
      entry.id === thread?.id ? { settings: workspace.settings } : {},
    );
  };
  const forkThread = () => {
    if (thread && canFork) void forkConversation(thread);
  };
  const offline = workspace.connection !== 'connected';
  const compatibilityOperations = workspace.operations.filter(
    (entry) => entry.kind === 'confirmCompatibility' && entry.target === compatibilityTarget,
  );
  const compatibilitySubmitting =
    checkingCompatibility ||
    busyFor('confirmCompatibility', compatibilityTarget) ||
    compatibilityOperations.some(
      (entry) => entry.status === 'accepted' || entry.status === 'dispatching',
    );
  const compatibilityUncertain = compatibilityOperations.some(
    (entry) => entry.status === 'unknown' && !entry.operation?.reconciliation,
  );

  async function refreshStatus() {
    if (statusCheck.current) return;
    statusCheck.current = true;
    setCheckingStatus(true);
    try {
      await Promise.all([workspace.refreshSystem(), workspace.refreshThread()]);
      // Reading history may recover a terminal execution. Read its receipt afterwards.
      await workspace.refreshOperations(true);
    } finally {
      statusCheck.current = false;
      setCheckingStatus(false);
    }
  }

  async function confirmCurrentCompatibility() {
    if (!canConfirm || compatibilityAttempt.current) return;
    compatibilityAttempt.current = true;
    setCheckingCompatibility(true);
    try {
      const freshSystem = await workspace.refreshSystem();
      const input = compatibilityConfirmationInput(
        compatibilityTarget,
        freshSystem,
        workspace.connection,
        workspace.authRequired,
      );
      if (!input) return;
      // Each explicit confirmation is a new authorization. Old uncertain receipts remain auditable.
      await workspace.run(
        'confirmCompatibility',
        compatibilityTarget,
        '/api/system/compatibility/confirm',
        input,
      );
    } finally {
      compatibilityAttempt.current = false;
      setCheckingCompatibility(false);
    }
  }

  const slashContext: SlashCommandContext = {
    project,
    selectedId: workspace.selectedId,
    thread,
    system,
    connection: workspace.connection,
    authRequired: workspace.authRequired,
    settings: workspace.settings,
    openDraft: workspace.openDraft,
    busy: workspace.busy,
    operations: workspace.operations,
    run: workspace.run,
    onResumeAttempt: () => {
      resumeAttempt.current = `${system?.codexEpoch}:${thread?.id}`;
    },
    refreshThread: workspace.refreshThread,
    openStatus: () => setDiagnosticsOpen(true),
    exportThread: downloadThreadExport,
  };
  const slashContextRef = useRef(slashContext);
  slashContextRef.current = slashContext;
  const slashCommands = createSlashCommands(() => slashContextRef.current);
  const renameCommand = slashCommands.find((command) => command.name === 'rename')!;

  async function sendMessage(text: string, steer: boolean, images?: string[]) {
    if (!canOperate || workspace.restoringSelection || workspace.savingModelDefaults) return false;
    if (!thread) {
      if (workspace.selectedId) return false;
      return workspace.sendFirstMessage(text, images);
    }
    if (steer && !activeTurn) return false;
    const operation = await workspace.run(
      steer ? 'steer' : 'send',
      thread.id,
      `/api/threads/${encode(thread.id)}/${steer ? 'steer' : 'turns'}`,
      steer
        ? { text, images, expectedTurnId: activeTurn!.id }
        : { text, images, settings: workspace.settings },
      { kind: 'send', key: workspace.draftKey, text, images },
    );
    return operation?.status === 'acknowledged';
  }

  return (
    <WorkspaceLayout threadId={thread?.id} getHistoryCursor={history.getHistoryCursor}>
      <Sidebar
        onGatewaySettings={() => {
          setSidebarOpen(false);
          setGatewaySettingsOpen(true);
        }}
        onUpdates={() => {
          setSidebarOpen(false);
          setUpdatesOpen(true);
        }}
        appVersion={updates.status?.version}
        updateAvailable={Boolean(
          updates.status?.available && updates.status.available.version !== updates.status.version,
        )}
        updating={updateActive(updates.status?.run)}
        onNotificationSettings={() => {
          setSidebarOpen(false);
          setNotificationSettingsOpen(true);
        }}
        notificationStatus={
          workspace.notifications.error
            ? '请检查设置'
            : workspace.notifications.enabled && workspace.notifications.access === 'granted'
              ? '已开启'
              : '未开启'
        }
        archiveView={workspace.archiveView}
        onArchiveView={workspace.setArchiveView}
        onArchive={(id, archived) => {
          void workspace.archiveThread(id, archived);
        }}
        onFork={(entry) => {
          void forkConversation(entry).then((operation) => {
            if (operation?.status === 'acknowledged') setSidebarOpen(false);
          });
        }}
        forkDisabledReason={forkDisabledReason}
        forking={isForking}
        archiveDisabledReason={(entry) => {
          if (busyFor('archive', entry.id)) return '正在保存…';
          if (unsettledFor(entry.id)) return '请先核对会话操作的结果';
          if (!canControl) return '连接恢复后可操作';
          if (compatibilityConfirmationRequired(system)) return '请先确认 Codex 版本兼容性';
          if (
            !system?.capabilities.includes(entry.archived ? 'thread/unarchive' : 'thread/archive')
          )
            return '当前 Codex 不支持此操作';
          if (!workspace.projects.find((project) => project.id === entry.projectId)?.available)
            return '项目目录不可用';
          if (!entry.archived && (isActive(entry.status) || entry.pendingActionCount > 0))
            return '任务结束并处理完待办后可归档';
          if (!entry.archived && entry.managed && entry.status === 'unknown')
            return '会话状态待核对，暂时无法归档';
          return undefined;
        }}
        projects={workspace.projects}
        projectsLoaded={workspace.projectsLoaded}
        projectId={workspace.projectId}
        onProject={(id) => {
          workspace.setProjectId(id);
          setSidebarOpen(false);
        }}
        projectThreads={workspace.projectThreads}
        selectedId={workspace.selectedId}
        isUnreadCompletion={isUnreadCompletion}
        onThread={(id, projectId) => {
          void workspace.selectThread(id, projectId);
        }}
        onMore={(projectId, cursor) => {
          void workspace.loadProjectThreads(projectId, cursor);
        }}
        onRetry={(projectId) => {
          void workspace.loadProjectThreads(
            projectId,
            workspace.projectThreads[projectId]?.retryCursor,
          );
        }}
        onRefresh={() => {
          void workspace.refreshProjects().then(workspace.refreshProjectsThreads);
        }}
        onAddProject={openAddProject}
        onManageProject={(project) => {
          setSidebarOpen(false);
          setProjectDialog({ kind: 'manage', id: project.id });
        }}
        canManageProjects={!workspace.authRequired}
        onCreate={(projectId) => {
          workspace.setProjectId(projectId);
          setSidebarOpen(false);
        }}
        creating={(projectId) =>
          workspace.firstMessages.includes(projectId) ||
          busyFor('create', projectId) ||
          unsettledFor(projectId)
        }
        canCreate={(projectId) =>
          canControl &&
          !workspace.savingModelDefaults &&
          !compatibilityConfirmationRequired(system) &&
          Boolean(workspace.projects.find((entry) => entry.id === projectId)?.available)
        }
        offline={offline}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className={`main-panel${shellOpen && !shellCollapsed ? ' shell-visible' : ''}`}>
        <header className="topbar">
          <div className="topbar-title">
            <Button
              className="mobile-only"
              variant="ghost"
              size="icon"
              aria-label="打开项目与会话"
              onClick={() => setSidebarOpen(true)}
            >
              <Icon name="menu" />
            </Button>
            <div>
              <div className="breadcrumb">
                {project?.name ?? '工作空间'}
                <Icon name="chevron" size={12} />
                <span>{workspace.selectedId ? '会话' : '新会话'}</span>
              </div>
              {thread ? (
                <ThreadTitle
                  key={`${thread.projectId}:${thread.id}`}
                  title={thread.title || '新会话'}
                  rename={renameCommand}
                  pending={Boolean(
                    thread &&
                    workspace.operations.some(
                      (entry) => entry.kind === 'rename' && blocksTarget(entry, thread.id),
                    ),
                  )}
                />
              ) : (
                <h1>
                  {workspace.selectedId
                    ? (history.thread?.title ??
                      workspace.threads.find((entry) => entry.id === workspace.selectedId)?.title ??
                      '正在读取会话…')
                    : '开始你的下一项任务'}
                </h1>
              )}
            </div>
          </div>
          <div className="topbar-status">
            <Button
              variant="ghost"
              size="sm"
              className="shell-entry"
              aria-label="打开 Shell 面板"
              aria-expanded={shellOpen && !shellCollapsed}
              onClick={() => {
                setShellOpen(true);
                setShellCollapsed(false);
              }}
            >
              <Icon name="terminal" size={16} />
              <span>Shell</span>
              {shell.commands.some(shellActive) && (
                <span className="shell-entry-count" aria-label="运行中的 Shell 命令">
                  {shell.commands.filter(shellActive).length}
                </span>
              )}
            </Button>
            {thread && <Status status={thread.status} offline={offline} />}
            <ConnectionBadge connection={workspace.connection} />
            {thread?.forkedFromId && (
              <ControlHint id="thread-source-hint" content="返回原会话">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="返回原会话"
                  aria-describedby="thread-source-hint"
                  onClick={() => {
                    void workspace.selectThread(thread.forkedFromId!);
                  }}
                >
                  <ArrowLeft size={16} />
                </Button>
              </ControlHint>
            )}
            <Diagnostics
              system={system}
              connection={workspace.connection}
              operations={workspace.operations}
              thread={thread}
              selectedId={workspace.selectedId}
              threadReadFailed={Boolean(workspace.threadReadFailure?.id === workspace.selectedId)}
              busy={workspace.busy}
              open={diagnosticsOpen}
              onOpenChange={setDiagnosticsOpen}
              refreshing={checkingStatus}
              onDiscardMissing={workspace.discardMissingOperation}
              onRefresh={() => {
                void refreshStatus();
                if (offline) workspace.retryConnection();
              }}
              onReconcile={(id) => {
                void workspace
                  .run('reconcile', id, `/api/operations/${encode(id)}/reconcile`, {
                    confirmEnded: true,
                  })
                  .then((operation) => {
                    if (operation?.status === 'acknowledged') return refreshStatus();
                  });
              }}
            />
          </div>
        </header>
        {system?.demo && (
          <div className="demo-banner">
            模拟测试模式 · 当前执行结果来自显式启用的测试 app-server
          </div>
        )}
        {workspace.authRequired ? (
          <div className="error-banner persistent-banner" role="alert">
            <Icon name="alert" />
            登录已过期。任务不会因页面断开而被取消。
            <a className="button button-secondary button-small" href="/">
              重新打开登录入口
            </a>
          </div>
        ) : (
          offline && (
            <div className="connection-banner" role="status">
              <span>
                实时连接{workspace.connection === 'connecting' ? '正在建立' : '已断开，正在重连'}
                。当前显示上次已知状态。
              </span>
              <Button variant="ghost" size="sm" onClick={workspace.retryConnection}>
                立即重连
              </Button>
            </div>
          )
        )}
        {system && !system.ready && (
          <div className="error-banner persistent-banner" role="alert">
            Codex 尚不可用：{system.error ?? '请在私人电脑上检查 Codex 安装、认证与服务状态。'}
          </div>
        )}
        <CompatibilityNotice
          system={system}
          onOpenChange={setCompatibilityDialogOpen}
          canConfirm={canConfirm}
          submitting={compatibilitySubmitting}
          uncertain={compatibilityUncertain}
          error={workspace.error}
          onRefresh={() => {
            void workspace.refreshSystem();
            void workspace.refreshOperations();
          }}
          onConfirm={() => {
            void confirmCurrentCompatibility();
          }}
          onReconfirm={() => {
            void confirmCurrentCompatibility();
          }}
        />
        {workspace.error && (
          <div className="error-banner dismissible" role="alert">
            <div>
              <span>{workspace.error}</span>
              {workspace.errorDetails !== undefined && (
                <details className="raw-details">
                  <summary>错误详情</summary>
                  <pre>{JSON.stringify(workspace.errorDetails, null, 2)}</pre>
                </details>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭错误提示"
              onClick={workspace.clearError}
            >
              <Icon name="close" size={15} />
            </Button>
          </div>
        )}
        {workspace.operations
          .filter((entry) => entry.mutation)
          .map((entry) => (
            <div
              className="archive-notice mutation-notice"
              role="status"
              key={entry.clientOperationId}
            >
              {entry.kind === 'rename' ? <Pencil size={16} /> : <Icon name="archive" size={16} />}
              <span>
                {entry.kind === 'rename'
                  ? entry.status === 'unknown'
                    ? '重命名结果待确认'
                    : '正在保存会话名称…'
                  : entry.mutation!.archived
                    ? entry.status === 'unknown'
                      ? '归档结果待确认'
                      : '正在归档会话…'
                    : entry.status === 'unknown'
                      ? '取消归档结果待确认'
                      : '正在取消归档…'}
              </span>
              {entry.status === 'unknown' && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={checkingStatus}
                  onClick={() => void refreshStatus()}
                >
                  {checkingStatus ? '正在核对…' : '核对提交'}
                </Button>
              )}
            </div>
          ))}
        {thread?.archived && (
          <div className="archive-notice" role="status">
            <Icon name="archive" size={18} />
            <div>
              <strong>此会话已归档</strong>
              <p>历史已保留。取消归档后可继续对话。</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={
                !canOperate ||
                unsettledFor(thread.id) ||
                busyFor('archive') ||
                !system?.capabilities.includes('thread/unarchive')
              }
              onClick={() => {
                void workspace.archiveThread(thread.id, false);
              }}
            >
              {busyFor('archive') ? '正在保存…' : '取消归档'}
            </Button>
          </div>
        )}
        <Conversation
          thread={history.thread}
          history={{
            cached: history.cached,
            cacheExhausted: history.cacheExhausted,
            onLoadCachedOlder: history.loadCachedOlder,
            syncError: !thread ? workspace.error : history.error,
            loading: history.loading,
            error: history.error,
            onLoadOlder: history.loadOlder,
            opening: Boolean(workspace.selectedId && !thread),
            openingError: !thread ? workspace.error : undefined,
            onRetryOpen: () => {
              workspace.clearError();
              if (history.error) void history.loadOlder();
              void workspace.refreshThread();
            },
          }}
          readingEnabled={
            !sidebarOpen &&
            !projectDialog &&
            !diagnosticsOpen &&
            !workspace.authRequired &&
            !compatibilityDialogOpen
          }
          onReadCompleted={markCompletedRead}
          offline={offline}
          projectName={project?.name}
          needsProject={workspace.projectsLoaded && workspace.projects.length === 0}
          canAddProject={!workspace.authRequired}
          onAddProject={openAddProject}
          questionControls={{
            disabled:
              !canOperate ||
              !thread?.managed ||
              Boolean(thread.archived) ||
              Boolean(waitingForConfirmation) ||
              busyFor('send') ||
              busyFor('steer') ||
              busyFor('resume'),
            onReply: async (replies) =>
              sendMessage(encodeQuestionReplies(replies), Boolean(activeTurn)),
          }}
        />
        <div className="bottom-region">
          {actions.length > 0 && (
            <div className="pending-actions" aria-label="待处理请求">
              {actions.map((action) => (
                <ActionCard
                  key={action.actionId}
                  action={action}
                  disabled={
                    !canOperate ||
                    busyFor('resolve', action.actionId) ||
                    unsettledFor(action.actionId)
                  }
                  onResolve={(resolution) => {
                    void workspace.run(
                      'resolve',
                      action.actionId,
                      `/api/actions/${encode(action.actionId)}/resolve`,
                      { resolution },
                    );
                  }}
                />
              ))}
            </div>
          )}
          {waitingForConfirmation && (
            <div className="pending-notice" role="status">
              <Icon name="alert" size={15} />
              <span>
                {!thread
                  ? '新建会话的提交结果尚未确认。请先核对提交，避免重复创建。'
                  : pendingFork
                    ? 'Fork 结果尚未确认。请核对提交，暂时不能再次 Fork。'
                    : '提交结果尚未确认。请核对提交，也可以 Fork 已保存的历史为新会话。'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={checkingStatus}
                aria-expanded={diagnosticsOpen}
                aria-controls="diagnostics-panel"
                onClick={() => {
                  setDiagnosticsOpen(true);
                  void refreshStatus();
                }}
              >
                {checkingStatus ? '正在核对…' : '核对提交'}
              </Button>
              {thread && !pendingFork && (
                <Button variant="secondary" size="sm" disabled={!canFork} onClick={forkThread}>
                  Fork 为新会话
                </Button>
              )}
            </div>
          )}
          <Composer
            commands={slashCommands}
            thread={thread}
            threadLoading={workspace.restoringSelection || Boolean(workspace.selectedId && !thread)}
            draftKey={workspace.draftKey}
            sentDrafts={workspace.sentDrafts}
            projectName={project?.name}
            projectId={project?.available ? project.id : undefined}
            runtimeKey={
              system?.ready && workspace.connection === 'connected'
                ? `${system.codexEpoch}:${workspace.runtimeDefaultsRevision}`
                : undefined
            }
            settings={workspace.settings}
            models={system?.models ?? []}
            onSettings={workspace.setSettings}
            onSaveModelDefaults={workspace.saveModelDefaults}
            savingModelDefaults={workspace.savingModelDefaults}
            disabled={
              !canOperate ||
              workspace.restoringSelection ||
              Boolean(waitingForConfirmation) ||
              Boolean(thread?.archived)
            }
            canInterrupt={canControl && Boolean(thread?.managed && activeTurn)}
            submitting={
              workspace.firstMessages.includes(workspace.projectId) ||
              busyFor('send') ||
              busyFor('steer')
            }
            interrupting={busyFor('interrupt')}
            resuming={busyFor('resume')}
            canResume={!resumeBlocked}
            resumeAttempted={resumeAttempt.current === `${system?.codexEpoch}:${thread?.id}`}
            canFork={canFork}
            forking={forking}
            onFork={forkThread}
            onResume={resumeThread}
            onInterrupt={() => {
              if (thread && activeTurn)
                void workspace.run(
                  'interrupt',
                  thread.id,
                  `/api/threads/${encode(thread.id)}/interrupt`,
                  { expectedTurnId: activeTurn.id },
                );
            }}
            onSend={sendMessage}
          />
        </div>
        <ShellPanel
          open={shellOpen}
          project={project}
          shell={shell}
          canExecute={canOperate && Boolean(system?.capabilities.includes('command/exec'))}
          collapsed={shellCollapsed}
          onCollapse={() => setShellCollapsed((value) => !value)}
          onClose={() => setShellOpen(false)}
        />
      </main>
      {projectDialog && (projectDialog.kind === 'add' || managedProject) && (
        <ProjectDialog
          key={projectDialog.kind === 'add' ? 'add' : projectDialog.id}
          project={managedProject}
          disabled={workspace.authRequired}
          onAdd={workspace.addProject}
          onRename={workspace.renameProject}
          onRemove={workspace.removeProject}
          onClose={() =>
            setProjectDialog((current) => (current === projectDialog ? undefined : current))
          }
        />
      )}
      {notificationSettingsOpen && (
        <NotificationSettings
          notifications={workspace.notifications}
          onClose={() => setNotificationSettingsOpen(false)}
        />
      )}
      {gatewaySettingsOpen && <GatewaySettings onClose={() => setGatewaySettingsOpen(false)} />}
      {updatesOpen && <UpdateSettings updates={updates} onClose={() => setUpdatesOpen(false)} />}
    </WorkspaceLayout>
  );
}
