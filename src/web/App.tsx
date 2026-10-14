import { useRef, useState } from 'react';
import { useWorkspace } from './hooks/useWorkspace';
import { Sidebar } from './components/Sidebar';
import { Conversation } from './components/Conversation';
import { Composer } from './components/Composer';
import { ActionCard } from './components/ActionCard';
import { ConnectionBadge, Diagnostics } from './components/Diagnostics';
import { isActive, Status } from './components/Status';
import { Icon } from './components/Icon';
import { Button } from './components/ui/button';
import { blocksTarget } from './lib/operations';
import { CompatibilityNotice } from './components/CompatibilityNotice';
import {
  canConfirmCompatibility,
  compatibilityConfirmationRequired,
  compatibilityConfirmationInput,
  compatibilityFingerprint,
} from './lib/compatibility';

const encode = encodeURIComponent;

export function App() {
  const workspace = useWorkspace();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const statusCheck = useRef(false);
  const [checkingCompatibility, setCheckingCompatibility] = useState(false);
  const compatibilityAttempt = useRef(false);
  const project = workspace.projects.find((entry) => entry.id === workspace.projectId);
  const { thread, system } = workspace;
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
      (action) => action.status === 'pending' || action.status === 'responding',
    ) ?? [];
  const waitingForConfirmation = thread && (unsettledFor(thread.id) || thread.status === 'unknown');
  const pendingFork = Boolean(
    thread &&
    workspace.operations.some((entry) => entry.kind === 'fork' && blocksTarget(entry, thread.id)),
  );
  const supportsFork = system?.capabilities.includes('thread/fork') ?? false;
  const forking = busyFor('fork') || pendingFork;
  const canFork = Boolean(thread?.turns.length && canOperate && supportsFork && !forking);
  const forkThread = () => {
    if (!thread || !canFork) return;
    void workspace.run('fork', thread.id, `/api/threads/${encode(thread.id)}/fork`, {
      settings: workspace.settings,
    });
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
      await workspace.refreshOperations();
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

  return (
    <div className="app-shell">
      <Sidebar
        projects={workspace.projects}
        projectId={workspace.projectId}
        onProject={workspace.setProjectId}
        projectThreads={workspace.projectThreads}
        selectedId={workspace.selectedId}
        onThread={(id, projectId) => {
          void workspace.selectThread(id, projectId);
        }}
        onMore={(projectId, cursor) => {
          void workspace.loadProjectThreads(projectId, cursor);
        }}
        onRetry={(projectId) => {
          void workspace.loadProjectThreads(projectId);
        }}
        onRefresh={() => {
          void workspace.refreshProjectsThreads();
        }}
        onCreate={(projectId) => {
          workspace.setProjectId(projectId);
          setSidebarOpen(false);
          void workspace.run('create', projectId, `/api/projects/${encode(projectId)}/threads`, {
            settings: workspace.getProjectSettings(projectId),
          });
        }}
        creating={(projectId) => busyFor('create', projectId) || unsettledFor(projectId)}
        canCreate={(projectId) =>
          canControl &&
          !compatibilityConfirmationRequired(system) &&
          Boolean(workspace.projects.find((entry) => entry.id === projectId)?.available)
        }
        offline={offline}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="main-panel">
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
                <span>{thread ? '会话' : '概览'}</span>
              </div>
              <h1>{thread?.title || (thread ? '新会话' : '开始你的下一项任务')}</h1>
            </div>
          </div>
          <div className="topbar-status">
            {thread && <Status status={thread.status} offline={offline} />}
            <ConnectionBadge connection={workspace.connection} />
            <Diagnostics
              system={system}
              connection={workspace.connection}
              operations={workspace.operations}
              thread={thread}
              busy={workspace.busy}
              open={diagnosticsOpen}
              onOpenChange={setDiagnosticsOpen}
              refreshing={checkingStatus}
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
        {thread && (
          <div className="thread-actions">
            <div className="thread-actions-description">
              {thread.forkedFromId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void workspace.selectThread(thread.forkedFromId!);
                  }}
                >
                  返回原会话
                </Button>
              )}
              <span>
                {!supportsFork
                  ? '当前 Codex 版本不支持 Fork 会话。'
                  : thread.turns.length === 0
                    ? '发送首条消息后可 Fork 已保存的历史。'
                    : 'Fork 复制已保存的历史，不会停止原会话。同一目录的任务仍需依次执行。'}
              </span>
            </div>
            <Button variant="secondary" size="sm" disabled={!canFork} onClick={forkThread}>
              <Icon name="fork" size={14} />
              {forking ? '正在确认 Fork…' : 'Fork 会话'}
            </Button>
          </div>
        )}
        <Conversation thread={thread} offline={offline} projectName={project?.name} />
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
                {pendingFork
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
              {!pendingFork && (
                <Button variant="secondary" size="sm" disabled={!canFork} onClick={forkThread}>
                  Fork 为新会话
                </Button>
              )}
            </div>
          )}
          <Composer
            thread={thread}
            draftKey={workspace.selectedId ?? `project:${workspace.projectId}`}
            projectName={project?.name}
            settings={workspace.settings}
            models={system?.models ?? []}
            onSettings={workspace.setSettings}
            disabled={!canOperate || Boolean(waitingForConfirmation)}
            canInterrupt={canControl && Boolean(activeTurn)}
            submitting={busyFor('send') || busyFor('steer')}
            interrupting={busyFor('interrupt')}
            resuming={busyFor('resume')}
            canFork={canFork}
            forking={forking}
            onFork={forkThread}
            onResume={(confirmed) => {
              if (thread)
                void workspace
                  .run('resume', thread.id, `/api/threads/${encode(thread.id)}/resume`, {
                    confirmExternalStopped: confirmed,
                    settings: workspace.settings,
                  })
                  .then(() => workspace.refreshThread());
            }}
            onInterrupt={() => {
              if (thread && activeTurn)
                void workspace.run(
                  'interrupt',
                  thread.id,
                  `/api/threads/${encode(thread.id)}/interrupt`,
                  { expectedTurnId: activeTurn.id },
                );
            }}
            onSend={async (text, steer) => {
              if (!thread || (steer && !activeTurn)) return false;
              const operation = await workspace.run(
                steer ? 'steer' : 'send',
                thread.id,
                `/api/threads/${encode(thread.id)}/${steer ? 'steer' : 'turns'}`,
                steer
                  ? { text, expectedTurnId: activeTurn!.id }
                  : { text, settings: workspace.settings },
              );
              return operation?.status === 'acknowledged';
            }}
          />
        </div>
      </main>
    </div>
  );
}
