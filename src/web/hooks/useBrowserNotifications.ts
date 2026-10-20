import { scopeKey } from '../../shared/workspace-scope';
import { message } from '../i18n/messages';
import { t } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TurnCompletion } from '../../shared/types';
import {
  claimCompletion,
  completionNotification,
  notificationAccess,
  notificationsEnabled,
  NOTIFICATIONS_ENABLED_KEY,
} from '../lib/browser-notifications';

interface Options {
  projectName: (projectId: string) => string | undefined;
  openThread: (threadId: string, projectId: string) => void;
}

export function useBrowserNotifications(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const [enabled, setEnabled] = useState(notificationsEnabled);
  const [access, setAccess] = useState(notificationAccess);
  const [requesting, setRequesting] = useState(false);
  const requestInFlight = useRef(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      setEnabled(notificationsEnabled());
      setAccess(notificationAccess());
    };
    const sync = (event: StorageEvent) => {
      if (event.key === null || event.key === NOTIFICATIONS_ENABLED_KEY) refresh();
    };
    window.addEventListener('storage', sync);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const toggle = async () => {
    if (requestInFlight.current) return;
    setError(undefined);
    const current = notificationAccess();
    setAccess(current);
    if (enabled && current === 'granted') {
      try {
        localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, '0');
        setEnabled(false);
      } catch {
        setError(
          message('notifications:cannot_save_notification_settings_allow_browser_storage_for'),
        );
      }
      return;
    }
    if (!['default', 'granted'].includes(current)) return;
    requestInFlight.current = true;
    setRequesting(true);
    try {
      // Called directly from the user's click, before any asynchronous work.
      const permission = current === 'default' ? await Notification.requestPermission() : current;
      if (!mounted.current) return;
      setAccess(permission);
      if (permission === 'granted') {
        localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, '1');
        setEnabled(true);
      }
    } catch {
      if (mounted.current)
        setError(
          message(
            'notifications:cannot_enable_notifications_check_notification_permissions_and_site',
          ),
        );
    } finally {
      requestInFlight.current = false;
      if (mounted.current) setRequesting(false);
    }
  };

  const show = useCallback((title: string, options: NotificationOptions, onClick?: () => void) => {
    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
    notification.onerror = () => {
      if (mounted.current)
        setError(message('notifications:the_browser_could_not_show_notifications_check_browser'));
    };
  }, []);

  const notify = useCallback(
    async (completion: TurnCompletion) => {
      if (!notificationsEnabled() || notificationAccess() !== 'granted') return;
      const projectName = latest.current.projectName(scopeKey(completion.projectId));
      if (!projectName) return;
      try {
        if (!(await claimCompletion(completion.threadId, completion.turnId))) return;
        // The user may disable notifications or remove the project while the claim is pending.
        if (
          !mounted.current ||
          !notificationsEnabled() ||
          notificationAccess() !== 'granted' ||
          !latest.current.projectName(scopeKey(completion.projectId))
        )
          return;
        const message = completionNotification(completion, projectName);
        show(message.title, message.options, () =>
          latest.current.openThread(completion.threadId, scopeKey(completion.projectId)),
        );
      } catch {
        if (mounted.current)
          setError(
            message('notifications:cannot_show_notifications_or_save_deduplication_records_check'),
          );
      }
    },
    [show],
  );

  const test = () => {
    if (!notificationsEnabled() || notificationAccess() !== 'granted') return;
    setError(undefined);
    try {
      show(t('notifications:test_notification'), {
        body: t('notifications:project_session_and_completion_status_will_appear_here'),
      });
    } catch {
      setError(
        message('notifications:this_browser_cannot_show_system_notifications_check_browser'),
      );
    }
  };

  return { enabled, access, requesting, error, toggle, test, notify };
}

export type BrowserNotifications = ReturnType<typeof useBrowserNotifications>;
