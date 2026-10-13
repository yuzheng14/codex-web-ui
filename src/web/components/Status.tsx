import type { RunStatus } from '../../shared/types';
import { cn } from '../lib/utils';

export const runStatusLabels: Record<RunStatus, string> = {
  idle: '就绪',
  running: '执行中',
  waitingApproval: '等待审批',
  waitingInput: '等待回答',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  unknown: '状态待核对',
};
export function isActive(status?: RunStatus) {
  return status === 'running' || status === 'waitingApproval' || status === 'waitingInput';
}
export function Status({ status, offline = false }: { status: RunStatus; offline?: boolean }) {
  return (
    <span className={cn('status', `status-${status}`)}>
      <span className="status-dot" />
      {offline && isActive(status) ? '上次已知：' : ''}
      {runStatusLabels[status]}
    </span>
  );
}
