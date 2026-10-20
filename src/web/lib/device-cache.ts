export const HISTORY_CACHE_LIMIT = 8 * 1024 * 1024;
export const HISTORY_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const RECORD_LIMIT = 256;
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
let writes = Promise.resolve();

/** Shared storage and maintenance: lookups read one record; eviction scans metadata only. */
export class DeviceCache {
  write(key: string, data: unknown) {
    const next = writes.then(() => this.save(key, data));
    writes = next.catch(() => {});
    return next;
  }
  remove(matches: (key: string[]) => boolean) {
    const next = writes.then(() => this.delete(matches));
    writes = next.catch(() => {});
    return next;
  }
  async read<T>(key: string): Promise<T | undefined> {
    const db = await open();
    if (!db) return;
    try {
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
      return JSON.parse(value.json) as T;
    } catch {
      return;
    } finally {
      db.close();
    }
  }
  private async save(key: string, data: unknown) {
    const db = await open();
    if (!db) return;
    try {
      const json = JSON.stringify(data);
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
      let count = all.length;
      for (const entry of all.sort((a, b) => a.savedAt - b.savedAt)) {
        if (
          total <= HISTORY_CACHE_LIMIT &&
          count <= RECORD_LIMIT &&
          entry.version === VERSION &&
          entry.savedAt >= Date.now() - HISTORY_CACHE_TTL
        )
          continue;
        pages.delete(entry.key);
        metadata.delete(entry.key);
        total -= entry.bytes;
        count--;
      }
      await complete;
    } catch {
      /* Quota, private mode and broken storage degrade to server paging. */
    } finally {
      db.close();
    }
  }
  private async delete(matches: (key: string[]) => boolean) {
    const db = await open();
    if (!db) return;
    try {
      const tx = db.transaction(['pages', 'metadata'], 'readwrite');
      const complete = finished(tx);
      void complete.catch(() => {});
      const metadata = tx.objectStore('metadata');
      for (const entry of (await result(metadata.getAll())) as Metadata[]) {
        if (matches(JSON.parse(entry.key) as string[])) {
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
