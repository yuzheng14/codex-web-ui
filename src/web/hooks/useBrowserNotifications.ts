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
        setError('无法保存通知设置，请允许此站点使用浏览器存储后重试。');
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
      if (mounted.current) setError('无法启用通知，请检查浏览器通知权限及此站点的存储设置。');
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
        setError('浏览器未能显示通知，请检查浏览器与系统的通知设置。页内状态与未读提示仍然可用。');
    };
  }, []);

  const notify = useCallback(
    async (completion: TurnCompletion) => {
      if (!notificationsEnabled() || notificationAccess() !== 'granted') return;
      const projectName = latest.current.projectName(completion.projectId);
      if (!projectName) return;
      try {
        if (!(await claimCompletion(completion.threadId, completion.turnId))) return;
        // The user may disable notifications or remove the project while the claim is pending.
        if (
          !mounted.current ||
          !notificationsEnabled() ||
          notificationAccess() !== 'granted' ||
          !latest.current.projectName(completion.projectId)
        )
          return;
        const message = completionNotification(completion, projectName);
        show(message.title, message.options, () =>
          latest.current.openThread(completion.threadId, completion.projectId),
        );
      } catch {
        if (mounted.current)
          setError(
            '无法显示通知或保存去重记录，请检查浏览器通知权限与站点存储。页内状态与未读提示仍然可用。',
          );
      }
    },
    [show],
  );

  const test = () => {
    if (!notificationsEnabled() || notificationAccess() !== 'granted') return;
    setError(undefined);
    try {
      show('通知测试', { body: 'Agent 工作结束时，会在这里显示项目、会话和结束状态。' });
    } catch {
      setError('当前浏览器无法显示系统通知，请检查浏览器与系统的通知设置。');
    }
  };

  return { enabled, access, requesting, error, toggle, test, notify };
}

export type BrowserNotifications = ReturnType<typeof useBrowserNotifications>;
