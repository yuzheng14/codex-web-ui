import { useState } from 'react';
import type { Operation, SystemInfo, ThreadView } from '../../shared/types';
import type { SavedOperation } from '../lib/operations';
import { needsReconciliation } from '../lib/operations';
import type { ConnectionState } from '../lib/realtime';
import { formatTime } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive } from './Status';

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
  busy,
}: {
  entry: SavedOperation;
  thread?: ThreadView;
  onReconcile: (id: string) => void;
  busy: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const execution = entry.operation?.execution;
  const currentlyActive = Boolean(
    thread && isActive(thread.status) && execution?.threadId === thread.id,
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
      {entry.error && <p className="inline-error">{entry.error}</p>}
      {entry.kind === 'confirmCompatibility' && entry.status === 'unknown' && (
        <p className="subtle">
          兼容性确认结果待核对，请刷新状态。此记录不代表任务执行，也不会自动重新提交。
        </p>
      )}
      {entry.kind !== 'confirmCompatibility' &&
        needsReconciliation(entry) &&
        !entry.operation?.reconciliation && (
          <div className="reconcile">
            <p>不会自动重发任务。先检查会话历史和原执行环境，再核对这笔提交。</p>
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
                  我已核实对应旧运行已经结束
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!confirmed || busy}
                  onClick={() => onReconcile(entry.clientOperationId)}
                >
                  核对并解除旧占用
                </Button>
              </>
            )}
          </div>
        )}
      {entry.operation?.reconciliation && (
        <p className="subtle">
          已于 {formatTime(entry.operation.reconciliation.at)}{' '}
          人工核对旧运行结束。保留原始提交状态。
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
  onRefresh,
  onReconcile,
  busy,
}: {
  system?: SystemInfo;
  connection: ConnectionState;
  operations: SavedOperation[];
  thread?: ThreadView;
  onRefresh: () => void;
  onReconcile: (id: string) => void;
  busy: string[];
}) {
  return (
    <details className="diagnostics">
      <summary>
        <Icon name="settings" size={16} />
        状态诊断{operations.length > 0 && <span className="count-badge">{operations.length}</span>}
      </summary>
      <div className="diagnostics-panel">
        <div className="diagnostics-heading">
          <h2>运行状态</h2>
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <Icon name="refresh" size={14} />
            刷新状态
          </Button>
        </div>
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
        {operations.length > 0 && (
          <section className="operation-section">
            <h3>操作与状态核对</h3>
            {operations.map((entry) => (
              <OperationCard
                key={entry.clientOperationId}
                entry={entry}
                thread={thread}
                onReconcile={onReconcile}
                busy={busy.includes(`reconcile:${entry.clientOperationId}`)}
              />
            ))}
          </section>
        )}
      </div>
    </details>
  );
}
