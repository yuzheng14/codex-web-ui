import { t } from '../i18n';
import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { Button } from './ui/button';

/** Shared desktop side panel / compact modal, including focus restoration and Escape. */
export function FilePreviewPanel({
  label,
  closeLabel = t('preview:close', { v0: label }),
  title,
  subtitle,
  icon,
  actions,
  onClose,
  children,
}: {
  label: string;
  closeLabel?: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement;
    const compact = window.matchMedia('(max-width: 1279px)');
    const updateMode = () => {
      element.close();
      if (compact.matches) element.showModal();
      else element.show();
    };
    updateMode();
    closeButton.current?.focus({ preventScroll: true });
    compact.addEventListener('change', updateMode);
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('dialog[open]:modal:not(.file-preview)')
      ) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      compact.removeEventListener('change', updateMode);
      document.removeEventListener('keydown', escape);
      element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, [onClose]);
  return (
    <dialog
      ref={dialog}
      className="file-preview"
      aria-label={label}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
    >
      <header className="file-preview-header">
        <Button
          ref={closeButton}
          variant="ghost"
          size="icon"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <ArrowLeft className="file-preview-back" size={20} />
          <X className="file-preview-close" size={20} />
        </Button>
        {icon}
        <div className="file-preview-title">
          <h2>{title}</h2>
          <span>{subtitle}</span>
        </div>
        {actions}
      </header>
      {children}
    </dialog>
  );
}
