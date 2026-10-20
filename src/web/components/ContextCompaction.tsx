import { t } from '../i18n';
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
      inProgress: t('conversation:compacting_context'),
      completed: t('conversation:context_compacted'),
      failed: t('conversation:context_compaction_failed'),
      interrupted: t('conversation:context_compaction_interrupted'),
    }[status] ?? t('conversation:context_compaction_state_unknown');
  const detail =
    item.error ??
    (running
      ? t('conversation:organizing_context_the_current_task_will_continue_when')
      : status === 'unknown'
        ? t('conversation:no_definite_completion_result_received_check_subsequent_task')
        : undefined);
  return (
    <div
      className={`context-compaction context-compaction-${status}`}
      data-testid="context-compaction"
      data-state={status}
      role={status === 'failed' ? 'alert' : 'status'}
      aria-label={t('conversation:context_compaction_status')}
    >
      <span className="compaction-icon">
        <Icon
          name={status === 'failed' ? 'alert' : status === 'completed' ? 'check' : 'compress'}
          size={18}
        />
      </span>
      <div>
        <strong>
          {running && offline && t('common:last_known')}
          {label}
        </strong>
        {detail && <p>{detail}</p>}
      </div>
    </div>
  );
}
