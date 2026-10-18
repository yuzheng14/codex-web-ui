import { useEffect, useRef } from 'react';

const eventName = 'covro:prepare-upgrade-reload';
const tokenKey = 'covro.upgrade-tab';
interface SavedState {
  value: unknown;
  time: number;
}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('covro-upgrade', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('无法打开草稿备份，请关闭旧页面后重试'));
  });
}
async function snapshot(action: 'get' | 'put' | 'delete', key: string, value?: unknown) {
  let token = sessionStorage.getItem(tokenKey);
  if (!token && action !== 'put') return undefined;
  if (!token) {
    token = crypto.randomUUID();
    sessionStorage.setItem(tokenKey, token);
  }
  const db = await database();
  try {
    return await new Promise<SavedState | undefined>((resolve, reject) => {
      const tx = db.transaction('snapshots', action === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('snapshots');
      const id = `${token}:${key}`;
      const request =
        action === 'get'
          ? store.get(id)
          : action === 'delete'
            ? store.delete(id)
            : store.put({ value, time: Date.now() }, id);
      tx.oncomplete = () =>
        resolve(action === 'get' ? (request.result as SavedState | undefined) : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('草稿备份失败'));
    });
  } finally {
    db.close();
  }
}
/** Snapshots are tab scoped, used only for a controlled upgrade reload, and consumed on restore. */
export function useUpgradeReloadState<T>(key: string, read: () => T, restore: (value: T) => void) {
  const callbacks = useRef({ read, restore });
  callbacks.current = { read, restore };
  useEffect(() => {
    let active = true;
    const restored = (async () => {
      const saved = await snapshot('get', key);
      if (active && saved && Date.now() - saved.time < 24 * 60 * 60_000) {
        callbacks.current.restore(saved.value as T);
        await snapshot('delete', key);
      }
    })().catch(() => {});
    const prepare = (event: Event) => {
      const tasks = (event as CustomEvent<Promise<void>[]>).detail;
      tasks.push(
        restored.then(async () => {
          await snapshot('put', key, callbacks.current.read());
        }),
      );
    };
    window.addEventListener(eventName, prepare);
    return () => {
      active = false;
      window.removeEventListener(eventName, prepare);
    };
  }, [key]);
}
export async function reloadForUpgrade() {
  const tasks: Promise<void>[] = [];
  document.body.inert = true;
  try {
    sessionStorage.setItem(tokenKey, crypto.randomUUID());
    window.dispatchEvent(new CustomEvent(eventName, { detail: tasks }));
    await Promise.all(tasks);
    window.location.reload();
  } catch (error) {
    await Promise.allSettled(tasks);
    await Promise.allSettled([snapshot('delete', 'composer'), snapshot('delete', 'workspace')]);
    document.body.inert = false;
    throw error;
  }
}
