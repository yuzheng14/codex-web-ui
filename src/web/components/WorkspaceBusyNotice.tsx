import type { RunStatus } from '../../shared/types';
import { Button } from './ui/button';
import { Status, runStatusLabels } from './Status';

export function WorkspaceBusyNotice({
  details,
  onOpen,
}: {
  details: unknown;
  onOpen: (threadId: string) => void;
}) {
  if (
    !details ||
    typeof details !== 'object' ||
    !('threadId' in details) ||
    typeof details.threadId !== 'string'
  )
    return null;
  const threadId = details.threadId;
  const title =
    'threadTitle' in details && typeof details.threadTitle === 'string'
      ? details.threadTitle
      : threadId;
  const status: RunStatus =
    'status' in details &&
    typeof details.status === 'string' &&
    Object.hasOwn(runStatusLabels, details.status)
      ? (details.status as RunStatus)
      : 'unknown';
  return (
    <div className="workspace-busy-notice">
      <div className="workspace-busy-owner">
        <strong>占用会话：{title}</strong>
        <Status status={status} />
      </div>
      <p>
        {status === 'unknown'
          ? '尚未确认旧任务已结束。请打开占用会话查看历史，必要时在状态诊断中核对旧占用。'
          : '同一工作目录每次只能执行一个任务。请等待该任务结束，或打开占用会话处理审批、中断任务。'}
      </p>
      <Button variant="secondary" size="sm" onClick={() => onOpen(threadId)}>
        查看占用会话
      </Button>
    </div>
  );
}
