import type { AutoReviewView } from '../../shared/types';
import { Icon } from './Icon';
import { CollapsibleActivity } from './CollapsibleActivity';
import './activity-group.css';

const statusLabels: Record<AutoReviewView['status'], string> = {
  inProgress: '审核中',
  approved: '已允许',
  denied: '已拒绝',
  timedOut: '审核超时',
  aborted: '审核已中止',
  unknown: '结果未确认',
};
const riskLabels = { low: '低', medium: '中', high: '高', critical: '极高' };
const authorizationLabels = {
  unknown: '未知',
  low: '低',
  medium: '中',
  high: '高',
};

function reviewTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { hour12: false })
    : '未提供有效时间';
}

export function AutoReviewCard({ review }: { review: AutoReviewView }) {
  return (
    <CollapsibleActivity
      className={`auto-review-card auto-review-${review.status}`}
      label={`自动审核结果：${review.actionSummary || review.actionLabel}，${statusLabels[review.status]}`}
      summary={
        <>
          <Icon
            name={
              review.status === 'approved'
                ? 'check'
                : review.status === 'denied'
                  ? 'close'
                  : review.status === 'inProgress'
                    ? 'refresh'
                    : 'alert'
            }
            size={15}
          />
          <span className="activity-description">
            <span className="activity-label">自动审核</span>
            <code className="command-summary">{review.actionSummary || review.actionLabel}</code>
          </span>
          <span className="auto-review-status" role="status">
            {statusLabels[review.status]}
          </span>
        </>
      }
    >
      <div className="activity-body auto-review-body">
        <div className="auto-review-operation">
          <span>{review.actionLabel}</span>
          <code>{review.actionSummary || '未提供被审核操作。'}</code>
        </div>
        <div className="auto-review-rationale">
          <strong>审核原因</strong>
          <p>{review.rationale?.trim() ? review.rationale : '未提供审核原因。'}</p>
        </div>
        <details className="auto-review-details">
          <summary>技术详情</summary>
          <dl>
            {review.cwd && (
              <>
                <dt>工作目录</dt>
                <dd>
                  <code>{review.cwd}</code>
                </dd>
              </>
            )}
            {review.riskLevel && (
              <>
                <dt>风险评估</dt>
                <dd>{riskLabels[review.riskLevel]}</dd>
              </>
            )}
            {review.userAuthorization && (
              <>
                <dt>用户授权评估</dt>
                <dd>{authorizationLabels[review.userAuthorization]}</dd>
              </>
            )}
            <dt>审核标识</dt>
            <dd>
              <code>{review.reviewId}</code>
            </dd>
            {review.targetItemId && (
              <>
                <dt>操作标识</dt>
                <dd>
                  <code>{review.targetItemId}</code>
                </dd>
              </>
            )}
            <dt>开始时间</dt>
            <dd>{reviewTime(review.startedAtMs)}</dd>
            {review.completedAtMs !== undefined && (
              <>
                <dt>结束时间</dt>
                <dd>{reviewTime(review.completedAtMs)}</dd>
              </>
            )}
          </dl>
        </details>
      </div>
    </CollapsibleActivity>
  );
}
