import { useEffect, useId, useRef, useState } from 'react';
import type { RunStatus, ThreadSummary } from '../../shared/types';
import { threadOrigin } from '../lib/thread-origin';
import { formatTime, cn } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive, runStatusLabels, Status } from './Status';

const statusIcons = {
  running: 'loader',
  waitingApproval: 'shieldPending',
  waitingInput: 'chat',
  failed: 'alert',
  interrupted: 'stop',
  unknown: 'question',
} as const;

function ThreadStatusIcon({
  status,
  label,
  offline,
  pending,
}: {
  status: RunStatus;
  label: string;
  offline: boolean;
  pending: boolean;
}) {
  return (
    <span
      className={cn('thread-status-indicator', `thread-status-${status}`)}
      data-status={status}
      role="img"
      aria-label={label}
      title={label}
    >
      <span
        className={cn(
          'thread-status-glyph',
          status === 'running' && !offline && 'thread-status-spinning',
        )}
      >
        {status === 'idle' || status === 'completed' ? (
          <span className="thread-status-dot" />
        ) : (
          <Icon name={statusIcons[status]} size={15} />
        )}
      </span>
      {(pending || status === 'waitingApproval') && <span className="thread-status-notification" />}
    </span>
  );
}

export function ThreadLink({
  thread,
  selected,
  unreadCompletion,
  offline,
  onSelect,
  onArchive,
  archiveDisabledReason,
}: {
  thread: ThreadSummary;
  selected: boolean;
  unreadCompletion: boolean;
  offline: boolean;
  onSelect: () => void;
  onArchive: () => void;
  archiveDisabledReason?: string;
}) {
  const tooltipId = useId();
  const detailsId = useId();
  const detailsButton = useRef<HTMLButtonElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tooltipDismissed, setTooltipDismissed] = useState(false);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!hovered) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTooltipDismissed(true);
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [hovered]);
  const title = thread.title || '未命名会话';
  const origin = threadOrigin(thread);
  const archiveLabel = thread.archived ? '取消归档' : '归档会话';
  const lastResult = thread.lastTurnStatus;
  const status =
    thread.status === 'idle' &&
    lastResult &&
    ['completed', 'failed', 'interrupted'].includes(lastResult)
      ? lastResult
      : thread.status;
  const statusLabel = `${offline && isActive(status) ? '上次已知：' : ''}${runStatusLabels[status]}${
    status === 'completed' && unreadCompletion ? ' · 未读' : ''
  }${thread.pendingActionCount > 0 ? ` · ${thread.pendingActionCount} 项待处理` : ''}`;
  const showStatus =
    (status !== 'idle' && status !== 'completed') ||
    unreadCompletion ||
    thread.pendingActionCount > 0;

  return (
    <div
      className="thread-row"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && detailsOpen) {
          event.stopPropagation();
          setDetailsOpen(false);
          detailsButton.current?.focus();
        }
      }}
    >
      <button
        className={cn('thread-link', selected && 'thread-selected')}
        data-thread-id={thread.id}
        title={title}
        onClick={() => {
          setDetailsOpen(false);
          onSelect();
        }}
        aria-current={selected ? 'page' : undefined}
      >
        {thread.forkedFromId && <Icon name="fork" size={14} />}
        <span className="thread-link-content">
          <span className="thread-title">{title}</span>
          <span className="sr-only"> · {statusLabel}</span>
        </span>
      </button>
      <div className="thread-row-actions">
        {showStatus ? (
          <ThreadStatusIcon
            status={status === 'completed' && !unreadCompletion ? 'idle' : status}
            label={statusLabel}
            offline={offline}
            pending={thread.pendingActionCount > 0}
          />
        ) : (
          <span className="thread-status-placeholder" aria-hidden="true" />
        )}
        <Button
          ref={detailsButton}
          variant="ghost"
          size="icon"
          className="thread-details-trigger"
          aria-label={`会话详情：${title}`}
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          title="会话详情与来源"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <Icon name="info" size={15} />
        </Button>
        <span
          className="thread-archive"
          onMouseEnter={() => {
            setHovered(true);
            setTooltipDismissed(false);
          }}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setTooltipDismissed(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setTooltipDismissed(true);
          }}
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label={archiveLabel}
            aria-describedby={tooltipId}
            aria-disabled={Boolean(archiveDisabledReason)}
            onClick={() => {
              setTooltipDismissed(true);
              if (!archiveDisabledReason) onArchive();
            }}
          >
            <Icon name={thread.archived ? 'unarchive' : 'archive'} size={15} />
          </Button>
          <span id={tooltipId} role="tooltip" className="keyboard-hint" hidden={tooltipDismissed}>
            {archiveDisabledReason ?? archiveLabel}
          </span>
        </span>
      </div>
      <section
        id={detailsId}
        className="thread-details"
        data-testid="thread-details"
        hidden={!detailsOpen}
        aria-labelledby={`${detailsId}-title`}
      >
        <h3 id={`${detailsId}-title`}>{title}</h3>
        <dl>
          <div>
            <dt>创建来源</dt>
            <dd>{origin.label}</dd>
          </div>
          {thread.updatedAt !== undefined && (
            <div>
              <dt>更新时间</dt>
              <dd>{formatTime(thread.updatedAt)}</dd>
            </div>
          )}
          <div>
            <dt>任务状态</dt>
            <dd>
              <Status status={status} offline={offline} />
            </dd>
          </div>
          {status === 'completed' && thread.lastTurnId && (
            <div>
              <dt>阅读状态</dt>
              <dd>{unreadCompletion ? '未读' : '已读'}</dd>
            </div>
          )}
          {thread.pendingActionCount > 0 && (
            <div>
              <dt>待处理</dt>
              <dd>{thread.pendingActionCount} 项待处理</dd>
            </div>
          )}
          {thread.forkedFromId && (
            <div>
              <dt>会话类型</dt>
              <dd>Fork 分支会话</dd>
            </div>
          )}
        </dl>
        <p>{origin.description}</p>
        <p className="thread-origin-note">来源记录创建时的入口，不代表当前运行位置或连接状态。</p>
        {archiveDisabledReason && <p>{archiveDisabledReason}</p>}
      </section>
    </div>
  );
}
