import { displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import type { SystemInfo } from '../../shared/types';
import { compatibilityFingerprint, shouldOpenCompatibilityDialog } from '../lib/compatibility';
import { Button } from './ui/button';
import { Icon } from './Icon';

interface Props {
  system?: SystemInfo;
  canConfirm: boolean;
  submitting: boolean;
  uncertain: boolean;
  error?: string;
  onConfirm: () => void;
  onReconfirm: () => void;
  onRefresh: () => void;
  onOpenChange?: (open: boolean) => void;
}

export function CompatibilityNotice(props: Props) {
  const { system } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string>();
  const [reopenedFingerprint, setReopenedFingerprint] = useState<string>();
  const fingerprint = compatibilityFingerprint(system);
  const open = shouldOpenCompatibilityDialog(system, dismissedFingerprint, reopenedFingerprint);

  useEffect(() => {
    props.onOpenChange?.(open);
  }, [open, props.onOpenChange]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
    return () => {
      if (element.open) element.close();
    };
  }, [open]);

  function dismiss() {
    setDismissedFingerprint(fingerprint);
    setReopenedFingerprint(undefined);
  }

  return (
    <>
      {system?.compatibility === 'unverified' && (
        <div className="compatibility-banner compatibility-notice" role="status">
          <span>
            {t('workspace:codex_has_not_been_verified_some_features_may', {
              v0: system.codexVersion,
              v1:
                system.compatibilityConfirmation === 'confirmed'
                  ? t('workspace:permission_to_continue_confirmed_this_does_not_verify')
                  : t('workspace:confirmation_required_before_use'),
            })}
          </span>
          {system.compatibilityConfirmation === 'required' && (
            <Button variant="ghost" size="sm" onClick={() => setReopenedFingerprint(fingerprint)}>
              {t('workspace:view_compatibility_notice')}
            </Button>
          )}
        </div>
      )}
      <dialog
        ref={dialog}
        className="compatibility-dialog"
        aria-labelledby="compatibility-title"
        aria-describedby="compatibility-description"
        onCancel={(event) => {
          event.preventDefault();
          dismiss();
        }}
      >
        <div className="compatibility-dialog-heading">
          <Icon name="alert" size={22} />
          <h2 id="compatibility-title">
            {t('workspace:codex_version_compatibility_is_unverified')}
          </h2>
        </div>
        <p id="compatibility-description">
          {t('workspace:this_codex_version_is_unverified_some_features_may')}
        </p>
        <dl>
          <dt>{t('common:running_version')}</dt>
          <dd>{system?.codexVersion ?? t('common:not_detected')}</dd>
          <dt>{t('common:verified_version')}</dt>
          <dd>{system?.verifiedVersion ?? t('common:loading')}</dd>
        </dl>
        {!system?.ready ? (
          <p className="inline-error" role="status">
            {t('workspace:codex_is_unavailable_close_this_notice_and_check')}
          </p>
        ) : (
          !props.canConfirm && (
            <p className="subtle" role="status">
              {t('workspace:wait_for_the_connection_and_codex_authentication_to')}
            </p>
          )
        )}
        {props.error && (
          <p className="inline-error" role="alert">
            {displayMessage(props.error)}
          </p>
        )}
        {props.uncertain && (
          <div className="compatibility-uncertain" role="status">
            <p>{t('workspace:the_confirmation_result_needs_checking_refresh_status_or')}</p>
            <Button variant="secondary" size="sm" onClick={props.onRefresh}>
              {t('workspace:refresh_confirmation_status')}
            </Button>
            {system?.ready && (
              <Button
                variant="secondary"
                size="sm"
                disabled={!props.canConfirm || props.submitting}
                onClick={props.onReconfirm}
              >
                {t('workspace:confirm_again')}
              </Button>
            )}
          </div>
        )}
        <p className="subtle">{t('workspace:you_can_still_view_diagnostics_or_interrupt_tasks')}</p>
        <div className="compatibility-dialog-actions">
          <Button variant="secondary" autoFocus onClick={dismiss}>
            {t('workspace:not_now')}
          </Button>
          {system?.ready && (
            <Button
              disabled={!props.canConfirm || props.submitting || props.uncertain}
              onClick={props.onConfirm}
            >
              {props.submitting ? t('workspace:confirming') : t('common:confirm_and_continue')}
            </Button>
          )}
        </div>
      </dialog>
    </>
  );
}
