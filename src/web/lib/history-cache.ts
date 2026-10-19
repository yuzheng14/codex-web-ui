import type { ThreadView } from '../../shared/types';

export const HISTORY_CACHE_LIMIT = 8 * 1024 * 1024;
export const HISTORY_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const ENTRY_LIMIT = 512 * 1024;
const VERSION = 1;
interface Metadata {
  key: string;
  bytes: number;
  savedAt: number;
  version: number;
}
interface StoredPage {
  json: string;
  digest: string;
}
const keyFor = (scope: string, project: string, thread: string, cursor = 'latest') =>
  JSON.stringify([scope, project, thread, cursor]);

async function digest(json: string) {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function open(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(undefined);
      const request = indexedDB.open('covro-conversation-history', VERSION);
      let abandoned = false;
      const timeout = setTimeout(() => {
        abandoned = true;
        resolve(undefined);
      }, 1000);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('pages');
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      request.onblocked = request.onerror = () => {
        clearTimeout(timeout);
        resolve(undefined);
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (abandoned) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    } catch {
      resolve(undefined);
    }
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
/** Cached execution state must never be mistaken for current control state. */
export function cachedReadingView(thread: ThreadView): ThreadView {
  return {
    ...thread,
    managed: false,
    status: 'unknown',
    actions: [],
    execution: undefined,
    resumeError: undefined,
    runtimeSettings: undefined,
    turns: thread.turns.map((turn) => ({
      ...turn,
      status: ['running', 'waitingApproval', 'waitingInput'].includes(turn.status)
        ? 'unknown'
        : turn.status,
      reconnect: undefined,
      items: turn.items.map((item) => ({
        ...item,
        status: ['running', 'inProgress'].includes(item.status ?? '') ? 'unknown' : item.status,
      })),
    })),
  };
}

/** Each lookup reads one page. Maintenance scans metadata only, never all message bodies. */
export class HistoryCache {
  constructor(readonly scope: string) {}
  async read(project: string, thread: string, cursor?: string): Promise<ThreadView | undefined> {
    const db = await open();
    if (!db) return;
    try {
      const key = keyFor(this.scope, project, thread, cursor);
      const tx = db.transaction(['pages', 'metadata']);
      const [meta, value] = await Promise.all([
        result(tx.objectStore('metadata').get(key)) as Promise<Metadata | undefined>,
        result(tx.objectStore('pages').get(key)) as Promise<StoredPage | undefined>,
      ]);
      if (
        !meta ||
        meta.version !== VERSION ||
        meta.savedAt < Date.now() - HISTORY_CACHE_TTL ||
        !value ||
        typeof value.json !== 'string' ||
        meta.bytes > ENTRY_LIMIT ||
        (await digest(value.json)) !== value.digest
      )
        return;
      const page = JSON.parse(value.json) as ThreadView;
      if (page.id !== thread || page.projectId !== project || !Array.isArray(page.turns)) return;
      return cachedReadingView(page);
    } catch {
      return;
    } finally {
      db.close();
    }
  }
  async write(page: ThreadView, cursor?: string) {
    const db = await open();
    if (!db) return;
    try {
      const key = keyFor(this.scope, page.projectId, page.id, cursor);
      const json = JSON.stringify(cachedReadingView(page));
      const bytes = new TextEncoder().encode(json).length;
      if (bytes > ENTRY_LIMIT) return;
      const value: StoredPage = { json, digest: await digest(json) };
      const tx = db.transaction(['pages', 'metadata'], 'readwrite');
      const complete = finished(tx);
      void complete.catch(() => {});
      const metadata = tx.objectStore('metadata');
      const pages = tx.objectStore('pages');
      metadata.put({ key, bytes, savedAt: Date.now(), version: VERSION } satisfies Metadata);
      pages.put(value, key);
      const all = (await result(metadata.getAll())) as Metadata[];
      let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of all.sort((a, b) => a.savedAt - b.savedAt)) {
        if (
          total <= HISTORY_CACHE_LIMIT &&
          entry.version === VERSION &&
          entry.savedAt >= Date.now() - HISTORY_CACHE_TTL
        )
          continue;
        pages.delete(entry.key);
        metadata.delete(entry.key);
        total -= entry.bytes;
      }
      await complete;
    } catch {
      /* Quota, private mode and broken storage degrade to server paging. */
    } finally {
      db.close();
    }
  }
  async remove(project: string, thread: string) {
    const db = await open();
    if (!db) return;
    try {
      const tx = db.transaction(['pages', 'metadata'], 'readwrite');
      const complete = finished(tx);
      void complete.catch(() => {});
      const metadata = tx.objectStore('metadata');
      for (const entry of (await result(metadata.getAll())) as Metadata[]) {
        const [scope, projectId, threadId] = JSON.parse(entry.key) as string[];
        if (scope === this.scope && projectId === project && threadId === thread) {
          tx.objectStore('pages').delete(entry.key);
          metadata.delete(entry.key);
        }
      }
      await complete;
    } catch {
      /* Optional storage. */
    } finally {
      db.close();
    }
  }
}
