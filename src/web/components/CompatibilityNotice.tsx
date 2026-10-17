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
            当前 Codex {system.codexVersion} 尚未验证兼容性，部分功能可能无法正常使用。
            {system.compatibilityConfirmation === 'confirmed'
              ? ' 已确认继续；这不代表版本已验证。'
              : ' 使用前需要确认。'}
          </span>
          {system.compatibilityConfirmation === 'required' && (
            <Button variant="ghost" size="sm" onClick={() => setReopenedFingerprint(fingerprint)}>
              查看兼容性提示
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
          <h2 id="compatibility-title">Codex 版本兼容性未经验证</h2>
        </div>
        <p id="compatibility-description">
          当前运行的 Codex 版本尚未验证，部分功能可能无法正常使用。确认继续后仍将保留兼容性提示。
        </p>
        <dl>
          <dt>运行版本</dt>
          <dd>{system?.codexVersion ?? '未检测到'}</dd>
          <dt>已验证版本</dt>
          <dd>{system?.verifiedVersion ?? '读取中'}</dd>
        </dl>
        {!system?.ready ? (
          <p className="inline-error" role="status">
            Codex 当前不可用，无法确认继续。请关闭此提示后查看状态诊断。
          </p>
        ) : (
          !props.canConfirm && (
            <p className="subtle" role="status">
              请等待连接和 Codex 认证恢复后再确认。
            </p>
          )
        )}
        {props.error && (
          <p className="inline-error" role="alert">
            {props.error}
          </p>
        )}
        {props.uncertain && (
          <div className="compatibility-uncertain" role="status">
            <p>
              确认请求的结果尚待核对。可刷新状态，或重新确认当前运行版本的使用许可；不会重发任务。
            </p>
            <Button variant="secondary" size="sm" onClick={props.onRefresh}>
              刷新确认状态
            </Button>
            {system?.ready && (
              <Button
                variant="secondary"
                size="sm"
                disabled={!props.canConfirm || props.submitting}
                onClick={props.onReconfirm}
              >
                重新确认
              </Button>
            )}
          </div>
        )}
        <p className="subtle">
          关闭提示后仍可查看诊断或中断当前任务。确认不会自动发送任务，未发送的草稿会保留。
        </p>
        <div className="compatibility-dialog-actions">
          <Button variant="secondary" autoFocus onClick={dismiss}>
            暂不使用
          </Button>
          {system?.ready && (
            <Button
              disabled={!props.canConfirm || props.submitting || props.uncertain}
              onClick={props.onConfirm}
            >
              {props.submitting ? '正在确认…' : '确认继续'}
            </Button>
          )}
        </div>
      </dialog>
    </>
  );
}
