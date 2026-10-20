import { reviewLabel, reviewSummary } from '../lib/auto-review-labels';
import { t, currentLocale } from '../i18n';
import type { AutoReviewView } from '../../shared/types';
import { Icon } from './Icon';
import { CollapsibleActivity } from './CollapsibleActivity';
import './activity-group.css';

const statusLabels: Record<AutoReviewView['status'], string> = {
  get inProgress() {
    return t('approvals:reviewing');
  },
  get approved() {
    return t('approvals:allowed');
  },
  get denied() {
    return t('common:denied');
  },
  get timedOut() {
    return t('common:review_timed_out');
  },
  get aborted() {
    return t('approvals:review_aborted');
  },
  get unknown() {
    return t('common:result_unconfirmed');
  },
};
const riskLabels = {
  get low() {
    return t('approvals:low');
  },
  get medium() {
    return t('approvals:medium');
  },
  get high() {
    return t('approvals:high');
  },
  get critical() {
    return t('approvals:critical');
  },
};
const authorizationLabels = {
  get unknown() {
    return t('approvals:unknown');
  },
  get low() {
    return t('approvals:low');
  },
  get medium() {
    return t('approvals:medium');
  },
  get high() {
    return t('approvals:high');
  },
};

function reviewTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(currentLocale(), { hour12: false })
    : t('approvals:no_valid_time_provided');
}

export function AutoReviewCard({ review }: { review: AutoReviewView }) {
  return (
    <CollapsibleActivity
      className={`auto-review-card auto-review-${review.status}`}
      label={t('approvals:automatic_review_2', {
        v0: reviewSummary(review) || reviewLabel(review),
        v1: statusLabels[review.status],
      })}
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
            <span className="activity-label">{t('approvals:automatic_review')}</span>
            <code className="command-summary">{reviewSummary(review) || reviewLabel(review)}</code>
          </span>
          <span className="auto-review-status" role="status">
            {statusLabels[review.status]}
          </span>
        </>
      }
    >
      <div className="activity-body auto-review-body">
        <div className="auto-review-operation">
          <span>{reviewLabel(review)}</span>
          <code>{reviewSummary(review) || t('approvals:no_reviewed_operation_provided')}</code>
        </div>
        <div className="auto-review-rationale">
          <strong>{t('approvals:review_rationale')}</strong>
          <p>
            {review.rationale?.trim()
              ? review.rationale
              : t('approvals:no_review_rationale_provided')}
          </p>
        </div>
        <details className="auto-review-details">
          <summary>{t('common:technical_details')}</summary>
          <dl>
            {review.cwd && (
              <>
                <dt>{t('common:working_directory')}</dt>
                <dd>
                  <code>{review.cwd}</code>
                </dd>
              </>
            )}
            {review.riskLevel && (
              <>
                <dt>{t('approvals:risk_assessment')}</dt>
                <dd>{riskLabels[review.riskLevel]}</dd>
              </>
            )}
            {review.userAuthorization && (
              <>
                <dt>{t('approvals:user_authorization_assessment')}</dt>
                <dd>{authorizationLabels[review.userAuthorization]}</dd>
              </>
            )}
            <dt>{t('approvals:review_id')}</dt>
            <dd>
              <code>{review.reviewId}</code>
            </dd>
            {review.targetItemId && (
              <>
                <dt>{t('approvals:operation_id')}</dt>
                <dd>
                  <code>{review.targetItemId}</code>
                </dd>
              </>
            )}
            <dt>{t('approvals:started_at')}</dt>
            <dd>{reviewTime(review.startedAtMs)}</dd>
            {review.completedAtMs !== undefined && (
              <>
                <dt>{t('approvals:finished_at')}</dt>
                <dd>{reviewTime(review.completedAtMs)}</dd>
              </>
            )}
          </dl>
        </details>
      </div>
    </CollapsibleActivity>
  );
}
