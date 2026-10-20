import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { ThreadListCache } from '../../src/web/lib/thread-list-cache';
import type { DeviceCache } from '../../src/web/lib/device-cache';
import type { HistoryCache } from '../../src/web/lib/history-cache';
import type { ThreadSummary, ThreadView } from '../../src/shared/types';

declare global {
  interface Window {
    listStorageTest: {
      ThreadListCache: typeof ThreadListCache;
      DeviceCache: typeof DeviceCache;
      HistoryCache: typeof HistoryCache;
    };
  }
}
test('lists share history storage limits and isolate filters, identities, corruption, expiry and removal', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents:
        "export * from './src/web/lib/thread-list-cache'; export * from './src/web/lib/device-cache'; export * from './src/web/lib/history-cache';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'listStorageTest',
  });
  await page.goto('/');
  await page.route('**/list-storage-test.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0]!.text }),
  );
  await page.addScriptTag({ url: '/list-storage-test.js' });
  const result = await page.evaluate(async () => {
    const { ThreadListCache, DeviceCache, HistoryCache } = window.listStorageTest;
    const cache = new ThreadListCache('one');
    const rows = Array.from({ length: 320 }, (_, i): ThreadSummary => ({
      id: String(i),
      title: 'cache row',
      projectId: 'project',
      source: 'appServer',
      status: 'running',
      managed: true,
      pendingActionCount: 9,
      lastTurnStatus: 'running',
    }));
    await cache.write('project', false, rows);
    const active = await cache.read('project', false);
    const otherUser = await new ThreadListCache('two').read('project', false);
    const otherProject = await cache.read('other-project', false);
    const archivedBefore = await cache.read('project', true);
    await cache.write('project', true, [{ ...rows[0]!, archived: true }]);
    const archived = await cache.read('project', true);
    const history = new HistoryCache('one');
    await history.write({
      ...rows[0]!,
      id: 'history',
      turns: [],
      actions: [],
      cwd: '/',
    } as ThreadView);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('covro-conversation-history');
      req.onsuccess = () => resolve(req.result);
    });
    const key = JSON.stringify(['one', 'project', 'thread-list', 'v1', 'active']);
    const tx = db.transaction('pages', 'readwrite');
    tx.objectStore('pages').put({ json: '{bad json', digest: 'bad' }, key);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    const corrupt = await cache.read('project', false);
    await new DeviceCache().write(key, [{ ...rows[0]!, originator: { invalid: true } }]);
    const malformed = await cache.read('project', false);
    await cache.write('project', false, [rows[0]!]);
    const tx2 = db.transaction('metadata', 'readwrite');
    const get = tx2.objectStore('metadata').get(key);
    get.onsuccess = () => tx2.objectStore('metadata').put({ ...get.result, savedAt: 0 });
    await new Promise<void>((resolve) => {
      tx2.oncomplete = () => resolve();
    });
    const expired = await cache.read('project', false);
    await cache.remove('project');
    const removed = await cache.read('project', true);
    const historyRetained = await history.read('project', 'history');
    const tx3 = db.transaction('metadata');
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      const req = tx3.objectStore('metadata').getAllKeys();
      req.onsuccess = () => resolve(req.result);
    });
    for (let i = 0; i < 270; i++)
      await new ThreadListCache(`scope-${i}`).write('project', false, []);
    const countAfterEviction = await new Promise<number>((resolve) => {
      const req = db.transaction('metadata').objectStore('metadata').count();
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return {
      count: active?.length,
      row: active?.[0],
      otherUser,
      otherProject,
      archivedBefore,
      archivedCount: archived?.length,
      corrupt,
      malformed,
      expired,
      removed,
      historyRetained: historyRetained?.id,
      keys,
      countAfterEviction,
    };
  });
  expect(result).toMatchObject({
    count: 300,
    row: { status: 'unknown', managed: false, pendingActionCount: 0 },
    archivedCount: 1,
    historyRetained: 'history',
  });
  expect(result.row?.lastTurnStatus).toBeUndefined();
  for (const key of [
    'otherUser',
    'otherProject',
    'archivedBefore',
    'corrupt',
    'malformed',
    'expired',
    'removed',
  ] as const)
    expect(result[key]).toBeUndefined();
  expect(result.keys).toHaveLength(1);
  expect(result.countAfterEviction).toBeLessThanOrEqual(256);
});
