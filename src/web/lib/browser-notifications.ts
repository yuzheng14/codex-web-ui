import { t } from '../i18n';
import type { TurnCompletion } from '../../shared/types';

export const NOTIFICATIONS_ENABLED_KEY = 'codex-web.notifications-enabled';
export type NotificationAccess = NotificationPermission | 'unsupported' | 'insecure';

export function notificationAccess(): NotificationAccess {
  if (!window.isSecureContext) return 'insecure';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export function notificationsEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function completionNotification(completion: TurnCompletion, projectName: string) {
  const status = {
    completed: t('notifications:agentCompleted'),
    failed: t('notifications:agentFailed'),
    interrupted: t('notifications:agentInterrupted'),
  }[completion.status];
  return {
    title: status,
    options: {
      body: `${projectName} · ${completion.title}`,
      tag: JSON.stringify([completion.threadId, completion.turnId]),
    },
  };
}

/** IndexedDB's unique key and transaction boundary arbitrate simultaneous tabs atomically.
 * Fail closed when storage is unavailable: in-page results remain usable without duplicates.
 */
export async function claimCompletion(threadId: string, turnId: string): Promise<boolean> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('codex-web.notifications', 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore('completions', { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error(t('notifications:notification_records_are_in_use_by_another_page')));
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  });
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction('completions', 'readwrite');
      const request = transaction.objectStore('completions').add({
        key: JSON.stringify([threadId, turnId]),
      });
      let duplicate = false;
      request.onerror = (event) => {
        if (request.error?.name !== 'ConstraintError') return;
        duplicate = true;
        event.preventDefault();
      };
      transaction.oncomplete = () => resolve(!duplicate);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
