import { useEffect, useRef, useState } from 'react';
import { Bell, ChevronRight, DatabaseBackup, Languages, Server, Settings } from 'lucide-react';
import { changeLocale, currentLocale, t } from '../i18n';
import { localeNames, supportedLocales, type Locale } from '../i18n/locales';
import { Button } from './ui/button';
import { Icon } from './Icon';

interface Props {
  notificationStatus: string;
  onNotificationSettings: () => void;
  onGatewaySettings: () => void;
  onBackups?: () => void;
}

export function SidebarSettings(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        className="sidebar-settings-trigger"
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Settings size={16} aria-hidden="true" />
        {t('sidebar:settings')}
      </Button>
      {open && <SettingsDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function SettingsDialog({ onClose, ...props }: Props & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { onBackups } = props;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const close = () => {
    // Close while still mounted so the browser can restore focus to the footer trigger.
    dialog.current?.close();
    onClose();
  };
  const navigate = (action: () => void) => {
    close();
    action();
  };
  return (
    <dialog
      ref={dialog}
      className="project-dialog sidebar-settings-dialog"
      aria-labelledby="sidebar-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <Settings size={20} aria-hidden="true" />
          <h2 id="sidebar-settings-title">{t('sidebar:settings')}</h2>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('common:close')} onClick={close}>
          <Icon name="close" size={17} />
        </Button>
      </div>
      <label className="language-selector">
        <Languages size={18} aria-hidden="true" />
        <span>{t('common:language')}</span>
        <select
          value={currentLocale()}
          onChange={(event) => void changeLocale(event.target.value as Locale)}
        >
          {supportedLocales.map((locale) => (
            <option key={locale} value={locale} lang={locale}>
              {localeNames[locale]}
            </option>
          ))}
        </select>
      </label>
      <div className="sidebar-settings-links">
        <Button
          variant="ghost"
          aria-label={t('sidebar:task_completion_notifications', { v0: props.notificationStatus })}
          onClick={() => navigate(props.onNotificationSettings)}
        >
          <Bell size={18} aria-hidden="true" />
          <span className="sidebar-settings-label">{t('sidebar:completion_notifications')}</span>
          <span className="sidebar-settings-status">{props.notificationStatus}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </Button>
        <Button variant="ghost" onClick={() => navigate(props.onGatewaySettings)}>
          <Settings size={18} aria-hidden="true" />
          <span className="sidebar-settings-label">{t('common:service_settings')}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </Button>
        {onBackups && (
          <Button variant="ghost" onClick={() => navigate(onBackups)}>
            <DatabaseBackup size={18} aria-hidden="true" />
            <span className="sidebar-settings-label">{t('backups:title')}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="sidebar-settings-execution">
        <Server size={17} aria-hidden="true" />
        <div>
          <strong>{t('sidebar:runs_on_server')}</strong>
          <p>{t('sidebar:code_and_credentials_stay_on_the_computer_running')}</p>
        </div>
      </div>
    </dialog>
  );
}
