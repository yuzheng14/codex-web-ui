import type { ItemView } from '../../shared/types';
import { Icon } from './Icon';

/** One visible notice per compaction: pinned while active, inline once settled. */
export function ContextCompaction({
  item,
  offline = false,
}: {
  item: ItemView;
  offline?: boolean;
}) {
  const status = item.status ?? 'unknown';
  const running = status === 'inProgress';
  const label =
    {
      inProgress: '正在压缩上下文…',
      completed: '上下文已压缩',
      failed: '上下文压缩失败',
      interrupted: '上下文压缩已中断',
    }[status] ?? '上下文压缩状态未知';
  const detail =
    item.error ??
    (running
      ? '正在整理会话上下文，完成后将继续当前任务。'
      : status === 'unknown'
        ? '未收到明确的完成结果，请查看后续任务状态。'
        : undefined);
  return (
    <div
      className={`context-compaction context-compaction-${status}`}
      data-testid="context-compaction"
      data-state={status}
      role={status === 'failed' ? 'alert' : 'status'}
      aria-label="上下文压缩状态"
    >
      <span className="compaction-icon">
        <Icon
          name={status === 'failed' ? 'alert' : status === 'completed' ? 'check' : 'compress'}
          size={18}
        />
      </span>
      <div>
        <strong>
          {running && offline && '上次已知：'}
          {label}
        </strong>
        {detail && <p>{detail}</p>}
      </div>
    </div>
  );
}
