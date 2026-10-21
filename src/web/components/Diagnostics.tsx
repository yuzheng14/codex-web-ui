import { displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import type { Operation, SystemInfo, ThreadView } from '../../shared/types';
import type { SavedOperation } from '../lib/operations';
import { canDiscardMissingOperation, needsReconciliation } from '../lib/operations';
import type { ConnectionState } from '../lib/realtime';
import { formatTime } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive } from './Status';
import { ThreadId } from './ThreadId';

const connectionLabels: Record<ConnectionState, string> = {
  get connecting() {
    return t('errors:connecting');
  },
  get connected() {
    return t('errors:live_connection_healthy');
  },
  get disconnected() {
    return t('errors:disconnected');
  },
  get authenticationRequired() {
    return t('errors:login_required_again');
  },
};
const operationLabels: Record<Operation['status'], string> = {
  get accepted() {
    return t('errors:accepted_by_gateway');
  },
  get dispatching() {
    return t('errors:awaiting_upstream_confirmation');
  },
  get acknowledged() {
    return t('errors:submission_confirmed_by_upstream');
  },
  get failed() {
    return t('errors:submission_failed');
  },
  get unknown() {
    return t('errors:submission_result_needs_checking');
  },
};

export function ConnectionBadge({ connection }: { connection: ConnectionState }) {
  return (
    <span className={`connection-badge connection-${connection}`}>
      <span className="status-dot" />
      {connectionLabels[connection]}
    </span>
  );
}

function OperationCard({
  entry,
  thread,
  onReconcile,
  onDiscardMissing,
  busy,
  refreshing,
}: {
  entry: SavedOperation;
  thread?: ThreadView;
  onReconcile: (id: string) => void;
  onDiscardMissing: (id: string) => void;
  busy: boolean;
  refreshing: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [discardConfirmed, setDiscardConfirmed] = useState(false);
  const execution = entry.operation?.execution;
  const fork = entry.kind === 'fork';
  const currentlyActive = Boolean(
    thread && isActive(thread.status) && execution?.threadId === thread.id,
  );
  const missingTaskActive = Boolean(
    !fork && thread && isActive(thread.status) && entry.target === thread.id,
  );
  return (
    <div className="operation-card">
      <div className="operation-title">
        <strong>{operationLabels[entry.status]}</strong>
        <span>{formatTime(entry.createdAt)}</span>
      </div>
      <dl>
        <dt>{t('errors:operation')}</dt>
        <dd>{entry.kind}</dd>
        <dt>{t('errors:target')}</dt>
        <dd>{entry.target}</dd>
        <dt>{t('errors:operation_id')}</dt>
        <dd>{entry.clientOperationId}</dd>
        {entry.lookupError?.details && (
          <dd>
            <details className="raw-details">
              <summary>{t('common:technical_details')}</summary>
              <pre>{entry.lookupError.details}</pre>
            </details>
          </dd>
        )}
        {execution && (
          <>
            <dt>{t('common:sessions')}</dt>
            <dd>{execution.threadId}</dd>
            <dt>{t('errors:workspace')}</dt>
            <dd>{execution.workspaceKey}</dd>
            <dt>{t('errors:execution_status')}</dt>
            <dd>{execution.ended ? t('errors:finished') : t('errors:end_not_confirmed')}</dd>
          </>
        )}
      </dl>
      {(entry.lookupError?.message || entry.error) && (
        <p className="inline-error" role="alert">
          {displayMessage(entry.lookupError?.message ?? entry.error)}
        </p>
      )}
      {canDiscardMissingOperation(entry) && (
        <div className="reconcile">
          <p>{t('errors:check_session_history_the_session_list_and_the')}</p>
          {missingTaskActive ? (
            <p>{t('errors:this_session_is_still_running_wait_or_interrupt')}</p>
          ) : (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={discardConfirmed}
                  onChange={(event) => setDiscardConfirmed(event.target.checked)}
                />
                {t('errors:i_checked_history_and_the_original_environment_no')}
              </label>
              <Button
                variant="secondary"
                size="sm"
                disabled={!discardConfirmed || busy || refreshing}
                onClick={() => onDiscardMissing(entry.clientOperationId)}
              >
                {t('errors:clear_this_browser_s_pending_record')}
              </Button>
            </>
          )}
        </div>
      )}
      {entry.kind === 'confirmCompatibility' && entry.status === 'unknown' && (
        <p className="subtle">
          {t('errors:refresh_status_to_check_the_compatibility_confirmation_this')}
        </p>
      )}
      {entry.kind !== 'confirmCompatibility' &&
        needsReconciliation(entry) &&
        !entry.lookupError?.missing &&
        !entry.operation?.reconciliation && (
          <div className="reconcile">
            <p>
              {fork
                ? t('errors:refresh_the_session_list_and_check_for_a')
                : t('errors:tasks_will_not_be_resent_automatically_check_history')}
            </p>
            {currentlyActive ? (
              <p>{t('errors:this_task_is_still_running_use_the_interrupt')}</p>
            ) : (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  {fork
                    ? t('errors:i_checked_the_session_list_and_history_and')
                    : t('errors:i_verified_that_the_previous_execution_has_ended')}
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!confirmed || busy || refreshing}
                  onClick={() => onReconcile(entry.clientOperationId)}
                >
                  {busy
                    ? t('errors:submitting_reconciliation')
                    : fork
                      ? t('errors:reconcile_this_fork')
                      : t('errors:reconcile_and_release_previous_execution')}
                </Button>
              </>
            )}
          </div>
        )}
      {entry.operation?.reconciliation && (
        <p className="subtle">
          {t('errors:checked_at_original_submission_status_preserved', {
            v0: formatTime(entry.operation.reconciliation.at),
            v1: fork
              ? t('errors:fork_result_checked_manually_original_task_state_unchanged')
              : t('errors:previous_execution_end_checked_manually'),
          })}
        </p>
      )}
    </div>
  );
}

export function Diagnostics({
  system,
  connection,
  operations,
  thread,
  selectedId,
  threadReadFailed,
  onRefresh,
  onReconcile,
  onDiscardMissing,
  busy,
  open,
  onOpenChange,
  refreshing,
}: {
  system?: SystemInfo;
  connection: ConnectionState;
  operations: SavedOperation[];
  thread?: ThreadView;
  selectedId?: string;
  threadReadFailed: boolean;
  onRefresh: () => void;
  onReconcile: (id: string) => void;
  onDiscardMissing: (id: string) => void;
  busy: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refreshing: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  return (
    <details
      className="diagnostics"
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary>
        <Icon name="settings" size={16} />
        {t('common:diagnostics')}
        {operations.length > 0 && <span className="count-badge">{operations.length}</span>}
      </summary>
      <div
        className="diagnostics-panel"
        id="diagnostics-panel"
        ref={panel}
        tabIndex={-1}
        role="region"
        aria-label={t('errors:diagnostics_details')}
        aria-busy={refreshing}
      >
        <div className="diagnostics-heading">
          <h2>{t('errors:execution_status')}</h2>
          <Button variant="ghost" size="sm" disabled={refreshing} onClick={onRefresh}>
            <Icon name="refresh" size={14} />
            {refreshing ? t('common:checking') : t('errors:refresh_status')}
          </Button>
        </div>
        <section className="operation-section" aria-label={t('errors:current_session_information')}>
          <h3>{t('errors:current_session')}</h3>
          <dl>
            <dt>Thread ID</dt>
            <dd>
              <ThreadId
                id={thread?.id === selectedId ? thread?.id : undefined}
                placeholder={
                  selectedId
                    ? threadReadFailed
                      ? t('errors:failed_to_load_session_details')
                      : t('errors:loading_session_details')
                    : t('common:session_not_created_yet')
                }
              />
            </dd>
          </dl>
        </section>
        <section className="operation-section">
          <h3>{t('errors:operations_and_reconciliation')}</h3>
          <p className="subtle" role="status">
            {refreshing
              ? t('errors:checking_session_history_and_submission_receipts')
              : thread?.status === 'unknown'
                ? t('errors:session_state_still_needs_checking_inspect_operation_records')
                : operations.length > 0
                  ? t('errors:check_submission_records_reconciliation_does_not_resend_tasks')
                  : t('errors:no_submissions_need_checking')}
          </p>
          {operations.map((entry) => (
            <OperationCard
              key={entry.clientOperationId}
              entry={entry}
              thread={thread}
              onReconcile={onReconcile}
              onDiscardMissing={onDiscardMissing}
              busy={
                busy.includes(`reconcile:${entry.clientOperationId}`) ||
                busy.includes(`${entry.kind}:${entry.target}`)
              }
              refreshing={refreshing}
            />
          ))}
        </section>
        <dl>
          <dt>{t('errors:browser_connection')}</dt>
          <dd>{connectionLabels[connection]}</dd>
          <dt>Codex</dt>
          <dd>
            {system?.ready
              ? t('errors:ready')
              : system?.connection === 'starting'
                ? t('errors:starting')
                : t('errors:unavailable')}
          </dd>
          <dt>{t('errors:account_authentication')}</dt>
          <dd>
            {system?.authenticated === true
              ? t('errors:available')
              : system?.authenticated === false
                ? t('errors:log_in_to_codex_on_the_server_computer')
                : t('errors:unconfirmed')}
          </dd>
          <dt>{t('common:running_version')}</dt>
          <dd>{system?.codexVersion ?? t('common:not_detected')}</dd>
          <dt>{t('common:verified_version')}</dt>
          <dd>{system?.verifiedVersion ?? t('common:loading')}</dd>
          <dt>{t('errors:compatibility')}</dt>
          <dd>
            {system?.compatibility === 'verified'
              ? t('errors:version_verified')
              : system?.compatibility === 'unverified'
                ? system.compatibilityConfirmation === 'confirmed'
                  ? t('errors:version_unverified_continued_with_consent')
                  : t('errors:version_unverified_confirmation_pending')
                : t('errors:unavailable')}
          </dd>
          <dt>{t('errors:gateway_authentication')}</dt>
          <dd>
            {system?.authMode === 'cloudflare-access'
              ? 'Cloudflare Access'
              : t('errors:local_mode')}
          </dd>
        </dl>
        {system?.error && <p className="inline-error">{displayMessage(system.error)}</p>}
        {system && (
          <details className="raw-details">
            <summary>{t('errors:supported_capabilities')}</summary>
            <p>{system.capabilities.join(' · ') || t('errors:none')}</p>
          </details>
        )}
      </div>
    </details>
  );
}
