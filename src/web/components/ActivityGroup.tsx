import type { ReactNode } from 'react';
import type { ItemView } from '../../shared/types';
import { summarizeActivities } from '../lib/activity-groups';
import { CollapsibleActivity } from './CollapsibleActivity';
import { Icon } from './Icon';
import './activity-group.css';

export function ActivityGroup({ items, children }: { items: ItemView[]; children: ReactNode }) {
  const status = summarizeActivities(items);
  const last = items.at(-1);
  const preview = last?.autoReview?.actionSummary || last?.command;
  const states = [
    { count: status.running, label: '执行中', className: 'activity-group-running' },
    { count: status.failed, label: '失败', className: 'activity-group-problem' },
    { count: status.denied, label: '已拒绝', className: 'activity-group-problem' },
    { count: status.timedOut, label: '审核超时', className: 'activity-group-attention' },
    { count: status.interrupted, label: '已中止', className: 'activity-group-attention' },
    { count: status.unknown, label: '结果未确认', className: 'activity-group-attention' },
    { count: status.completed, label: '已完成', className: '' },
  ].filter(({ count }) => count > 0);
  const stateLabel = states.map(({ label, count }) => `${label} ${count}`).join('，');
  return (
    <CollapsibleActivity
      className="activity-group"
      group
      label={`${status.total} 项活动${stateLabel ? `，${stateLabel}` : ''}`}
      summary={
        <>
          <Icon name={status.running ? 'refresh' : 'terminal'} size={16} />
          <span className="activity-description">
            <span className="activity-label">{status.total} 项活动</span>
            {status.reviews > 0 && (
              <span className="activity-group-reviews">含 {status.reviews} 次自动审核</span>
            )}
            {preview && <code className="command-summary">{preview}</code>}
          </span>
          <span className="activity-group-status" role="status">
            {states.map(({ label, count, className }) => (
              <span key={label} className={className}>
                {label} {count}
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
