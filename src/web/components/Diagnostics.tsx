import { useEffect, useRef, useState } from 'react';
import type { Operation, SystemInfo, ThreadView } from '../../shared/types';
import type { SavedOperation } from '../lib/operations';
import { canDiscardMissingOperation, needsReconciliation } from '../lib/operations';
import type { ConnectionState } from '../lib/realtime';
import { formatTime } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive } from './Status';
import { ThreadId } from './ThreadId';

const connectionLabels: Record<ConnectionState, string> = {
  connecting: '正在连接',
  connected: '实时连接正常',
  disconnected: '连接已断开',
  authenticationRequired: '需要重新登录',
};
const operationLabels: Record<Operation['status'], string> = {
  accepted: '网关已接受',
  dispatching: '等待上游确认',
  acknowledged: '上游已确认提交',
  failed: '提交失败',
  unknown: '提交结果待核对',
};

export function ConnectionBadge({ connection }: { connection: ConnectionState }) {
  return (
    <span className={`connection-badge connection-${connection}`}>
      <span className="status-dot" />
      {connectionLabels[connection]}
    </span>
  );
}

function OperationCard({
  entry,
  thread,
  onReconcile,
  onDiscardMissing,
  busy,
  refreshing,
}: {
  entry: SavedOperation;
  thread?: ThreadView;
  onReconcile: (id: string) => void;
  onDiscardMissing: (id: string) => void;
  busy: boolean;
  refreshing: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [discardConfirmed, setDiscardConfirmed] = useState(false);
  const execution = entry.operation?.execution;
  const fork = entry.kind === 'fork';
  const currentlyActive = Boolean(
    thread && isActive(thread.status) && execution?.threadId === thread.id,
  );
  const missingTaskActive = Boolean(
    !fork && thread && isActive(thread.status) && entry.target === thread.id,
  );
  return (
    <div className="operation-card">
      <div className="operation-title">
        <strong>{operationLabels[entry.status]}</strong>
        <span>{formatTime(entry.createdAt)}</span>
      </div>
      <dl>
        <dt>操作</dt>
        <dd>{entry.kind}</dd>
        <dt>目标</dt>
        <dd>{entry.target}</dd>
        <dt>操作 ID</dt>
        <dd>{entry.clientOperationId}</dd>
        {execution && (
          <>
            <dt>会话</dt>
            <dd>{execution.threadId}</dd>
            <dt>工作区</dt>
            <dd>{execution.workspaceKey}</dd>
            <dt>运行状态</dt>
            <dd>{execution.ended ? '已经结束' : '尚未确认终结'}</dd>
          </>
        )}
      </dl>
      {(entry.lookupError?.message || entry.error) && (
        <p className="inline-error" role="alert">
          {entry.lookupError?.message ?? entry.error}
        </p>
      )}
      {canDiscardMissingOperation(entry) && (
        <div className="reconcile">
          <p>
            请先检查会话历史、会话列表和原执行环境。清理仅移除此浏览器的待核对记录，不会停止任务或重新提交。
          </p>
          {missingTaskActive ? (
            <p>当前会话仍在执行，请等待结束或正常中断后再核对。</p>
          ) : (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={discardConfirmed}
                  onChange={(event) => setDiscardConfirmed(event.target.checked)}
                />
                我已检查历史和原执行环境，确认无需继续核对这笔提交
              </label>
              <Button
                variant="secondary"
                size="sm"
                disabled={!discardConfirmed || busy || refreshing}
                onClick={() => onDiscardMissing(entry.clientOperationId)}
              >
                清除此浏览器的待核对记录
              </Button>
            </>
          )}
        </div>
      )}
      {entry.kind === 'confirmCompatibility' && entry.status === 'unknown' && (
        <p className="subtle">
          兼容性确认结果待核对，请刷新状态。此记录不代表任务执行，也不会自动重新提交。
        </p>
      )}
      {entry.kind !== 'confirmCompatibility' &&
        needsReconciliation(entry) &&
        !entry.lookupError?.missing &&
        !entry.operation?.reconciliation && (
          <div className="reconcile">
            <p>
              {fork
                ? '请先刷新会话列表，检查是否已生成包含原历史的新会话。核对此次 Fork 不会停止原任务或改变原任务的执行状态。'
                : '不会自动重发任务。先检查会话历史和原执行环境，再核对这笔提交。'}
            </p>
            {currentlyActive ? (
              <p>当前任务仍在执行，请使用输入区的中断按钮。</p>
            ) : (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  {fork
                    ? '我已检查会话列表和历史，核实此次 Fork 的结果'
                    : '我已核实对应旧运行已经结束'}
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!confirmed || busy || refreshing}
                  onClick={() => onReconcile(entry.clientOperationId)}
                >
                  {busy ? '正在提交核对…' : fork ? '核对此次 Fork' : '核对并解除旧占用'}
                </Button>
              </>
            )}
          </div>
        )}
      {entry.operation?.reconciliation && (
        <p className="subtle">
          已于 {formatTime(entry.operation.reconciliation.at)}{' '}
          {fork ? '人工核对 Fork 结果。原任务状态不变。' : '人工核对旧运行结束。'}保留原始提交状态。
        </p>
      )}
    </div>
  );
}

export function Diagnostics({
  system,
  connection,
  operations,
  thread,
  selectedId,
  threadReadFailed,
  onRefresh,
  onReconcile,
  onDiscardMissing,
  busy,
  open,
  onOpenChange,
  refreshing,
}: {
  system?: SystemInfo;
  connection: ConnectionState;
  operations: SavedOperation[];
  thread?: ThreadView;
  selectedId?: string;
  threadReadFailed: boolean;
  onRefresh: () => void;
  onReconcile: (id: string) => void;
  onDiscardMissing: (id: string) => void;
  busy: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refreshing: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  return (
    <details
      className="diagnostics"
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary>
        <Icon name="settings" size={16} />
        状态诊断{operations.length > 0 && <span className="count-badge">{operations.length}</span>}
      </summary>
      <div
        className="diagnostics-panel"
        id="diagnostics-panel"
        ref={panel}
        tabIndex={-1}
        role="region"
        aria-label="状态诊断详情"
        aria-busy={refreshing}
      >
        <div className="diagnostics-heading">
          <h2>运行状态</h2>
          <Button variant="ghost" size="sm" disabled={refreshing} onClick={onRefresh}>
            <Icon name="refresh" size={14} />
            {refreshing ? '正在核对…' : '刷新状态'}
          </Button>
        </div>
        <section className="operation-section" aria-label="当前会话信息">
          <h3>当前会话</h3>
          <dl>
            <dt>Thread ID</dt>
            <dd>
              <ThreadId
                id={thread?.id === selectedId ? thread?.id : undefined}
                placeholder={
                  selectedId
                    ? threadReadFailed
                      ? '会话详情加载失败'
                      : '正在加载会话详情…'
                    : '会话尚未创建'
                }
              />
            </dd>
          </dl>
        </section>
        <section className="operation-section">
          <h3>操作与状态核对</h3>
          <p className="subtle" role="status">
            {refreshing
              ? '正在核对会话历史和提交回执…'
              : thread?.status === 'unknown'
                ? '会话状态仍待核对。请检查操作记录和原执行环境。'
                : operations.length > 0
                  ? '请查看提交记录；核对不会自动重发任务。'
                  : '没有待核对的提交。'}
          </p>
          {operations.map((entry) => (
            <OperationCard
              key={entry.clientOperationId}
              entry={entry}
              thread={thread}
              onReconcile={onReconcile}
              onDiscardMissing={onDiscardMissing}
              busy={
                busy.includes(`reconcile:${entry.clientOperationId}`) ||
                busy.includes(`${entry.kind}:${entry.target}`)
              }
              refreshing={refreshing}
            />
          ))}
        </section>
        <dl>
          <dt>网页连接</dt>
          <dd>{connectionLabels[connection]}</dd>
          <dt>Codex</dt>
          <dd>
            {system?.ready ? '已就绪' : system?.connection === 'starting' ? '启动中' : '不可用'}
          </dd>
          <dt>账户认证</dt>
          <dd>
            {system?.authenticated === true
              ? '可用'
              : system?.authenticated === false
                ? '需要在本机登录 Codex'
                : '尚未确认'}
          </dd>
          <dt>运行版本</dt>
          <dd>{system?.codexVersion ?? '未检测到'}</dd>
          <dt>已验证版本</dt>
          <dd>{system?.verifiedVersion ?? '读取中'}</dd>
          <dt>兼容性</dt>
          <dd>
            {system?.compatibility === 'verified'
              ? '版本已验证'
              : system?.compatibility === 'unverified'
                ? system.compatibilityConfirmation === 'confirmed'
                  ? '当前版本未经验证 · 已确认继续'
                  : '当前版本未经验证 · 待确认'
                : '不可用'}
          </dd>
          <dt>入口认证</dt>
          <dd>{system?.authMode === 'cloudflare-access' ? 'Cloudflare Access' : '本机模式'}</dd>
        </dl>
        {system?.error && <p className="inline-error">{system.error}</p>}
        {system && (
          <details className="raw-details">
            <summary>已支持能力</summary>
            <p>{system.capabilities.join(' · ') || '暂无'}</p>
          </details>
        )}
      </div>
    </details>
  );
}
