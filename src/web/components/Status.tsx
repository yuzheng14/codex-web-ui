import { t } from '../i18n';
import type { RunStatus } from '../../shared/types';
import { cn } from '../lib/utils';

export const runStatusLabels: Record<RunStatus, string> = {
  get idle() {
    return t('conversation:ready');
  },
  get running() {
    return t('common:running');
  },
  get waitingApproval() {
    return t('conversation:awaiting_approval');
  },
  get waitingInput() {
    return t('conversation:awaiting_answer');
  },
  get completed() {
    return t('common:completed');
  },
  get failed() {
    return t('common:failed');
  },
  get interrupted() {
    return t('common:interrupted');
  },
  get unknown() {
    return t('conversation:status_needs_checking');
  },
};
export function isActive(status?: RunStatus) {
  return status === 'running' || status === 'waitingApproval' || status === 'waitingInput';
}
export function Status({ status, offline = false }: { status: RunStatus; offline?: boolean }) {
  return (
    <span className={cn('status', `status-${status}`)}>
      <span className="status-dot" />
      {offline && isActive(status) ? t('common:last_known') : ''}
      {runStatusLabels[status]}
    </span>
  );
}
