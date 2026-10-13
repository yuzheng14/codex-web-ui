import { useState } from 'react';
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

const encode = encodeURIComponent;

export function App() {
  const workspace = useWorkspace();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const project = workspace.projects.find((entry) => entry.id === workspace.projectId);
  const { thread, system } = workspace;
  const canOperate = Boolean(
    system?.ready &&
    system.authenticated !== false &&
    project?.available &&
    workspace.connection === 'connected' &&
    !workspace.authRequired,
  );
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
  const offline = workspace.connection !== 'connected';

  return (
    <div className="app-shell">
      <Sidebar
        projects={workspace.projects}
        projectId={workspace.projectId}
        onProject={workspace.setProjectId}
        threads={workspace.threads}
        selectedId={workspace.selectedId}
        onThread={(id) => {
          void workspace.selectThread(id);
        }}
        nextCursor={workspace.nextCursor}
        loading={workspace.loadingThreads}
        onMore={() => {
          if (workspace.nextCursor) void workspace.loadThreads(workspace.nextCursor);
        }}
        onRefresh={() => {
          void workspace.loadThreads();
        }}
        onCreate={() => {
          void workspace.run(
            'create',
            workspace.projectId,
            `/api/projects/${encode(workspace.projectId)}/threads`,
            { settings: workspace.settings },
          );
        }}
        creating={busyFor('create', workspace.projectId) || unsettledFor(workspace.projectId)}
        canCreate={canOperate}
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
              onRefresh={() => {
                void workspace.refreshSystem();
                void workspace.refreshThread();
                void workspace.refreshOperations();
                workspace.retryConnection();
              }}
              onReconcile={(id) => {
                void workspace.run('reconcile', id, `/api/operations/${encode(id)}/reconcile`, {
                  confirmEnded: true,
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
        {system?.compatibility === 'unverified' && (
          <div className="compatibility-banner">
            当前 Codex 版本 {system.codexVersion} 尚未验证兼容性。详情见状态诊断。
          </div>
        )}
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
              提交结果尚未确认。请通过状态诊断核对，避免重复发送。
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void workspace.refreshOperations();
                }}
              >
                核对提交
              </Button>
            </div>
          )}
          <Composer
            thread={thread}
            projectName={project?.name}
            settings={workspace.settings}
            models={system?.models ?? []}
            onSettings={workspace.setSettings}
            disabled={!canOperate || Boolean(waitingForConfirmation)}
            submitting={busyFor('send') || busyFor('steer')}
            interrupting={busyFor('interrupt')}
            resuming={busyFor('resume')}
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
