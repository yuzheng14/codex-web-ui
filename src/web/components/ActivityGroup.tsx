import { reviewSummary } from '../lib/auto-review-labels';
import { t } from '../i18n';
import type { ReactNode } from 'react';
import type { ItemView } from '../../shared/types';
import { summarizeActivities } from '../lib/activity-groups';
import { CollapsibleActivity } from './CollapsibleActivity';
import { Icon } from './Icon';
import './activity-group.css';

export function ActivityGroup({ items, children }: { items: ItemView[]; children: ReactNode }) {
  const status = summarizeActivities(items);
  const last = items.at(-1);
  const preview = (last?.autoReview ? reviewSummary(last.autoReview) : undefined) || last?.command;
  const states = [
    { count: status.running, label: t('common:running'), className: 'activity-group-running' },
    { count: status.failed, label: t('common:failed'), className: 'activity-group-problem' },
    { count: status.denied, label: t('common:denied'), className: 'activity-group-problem' },
    {
      count: status.timedOut,
      label: t('common:review_timed_out'),
      className: 'activity-group-attention',
    },
    {
      count: status.interrupted,
      label: t('conversation:aborted'),
      className: 'activity-group-attention',
    },
    {
      count: status.unknown,
      label: t('common:result_unconfirmed'),
      className: 'activity-group-attention',
    },
    { count: status.completed, label: t('common:completed'), className: '' },
  ].filter(({ count }) => count > 0);
  const stateLabel = states
    .map(({ label, count }) => t('conversation:activityState', { status: label, count }))
    .join(' · ');
  return (
    <CollapsibleActivity
      className="activity-group"
      group
      label={t('conversation:activities_2', {
        count: status.total,
        v0: status.total,
        v1: stateLabel ? ` · ${stateLabel}` : '',
      })}
      summary={
        <>
          <Icon name={status.running ? 'refresh' : 'terminal'} size={16} />
          <span className="activity-description">
            <span className="activity-label">
              {t('conversation:activities', { count: status.total, v0: status.total })}
            </span>
            {status.reviews > 0 && (
              <span className="activity-group-reviews">
                {t('conversation:includes_automatic_reviews', {
                  count: status.reviews,
                  v0: status.reviews,
                })}
              </span>
            )}
            {preview && <code className="command-summary">{preview}</code>}
          </span>
          <span className="activity-group-status" role="status">
            {states.map(({ label, count, className }) => (
              <span key={label} className={className}>
                {t('conversation:activityState', { status: label, count })}
              </span>
            ))}
          </span>
        </>
      }
    >
      <div className="activity-group-items">{children}</div>
    </CollapsibleActivity>
  );
}
