import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { HistoryCache } from '../../src/web/lib/history-cache';
import type { ThreadView } from '../../src/shared/types';

declare global {
  interface Window {
    historyCacheTest: { HistoryCache: typeof HistoryCache; HISTORY_CACHE_LIMIT: number };
  }
}

test('bounds cache storage and isolates scope, project and thread; expires and invalidates data', async ({
  page,
}) => {
  const bundle = await build({
    entryPoints: ['src/web/lib/history-cache.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'historyCacheTest',
  });
  await page.goto('/');
  await page.route('**/history-cache-test.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0]!.text }),
  );
  await page.addScriptTag({ url: '/history-cache-test.js' });
  const result = await page.evaluate(async () => {
    const { HistoryCache, HISTORY_CACHE_LIMIT } = window.historyCacheTest;
    const cache = new HistoryCache('user-server-one');
    const page = (id: string): ThreadView => ({
      id,
      projectId: 'project',
      cwd: '/',
      source: 'test',
      title: id,
      managed: true,
      status: 'running',
      actions: [],
      history: { olderCursor: 'older' },
      turns: [
        {
          id: 'turn',
          threadId: id,
          status: 'running',
          items: [{ id: 'item', type: 'agentMessage', text: 'x'.repeat(300_000) }],
        },
      ],
    });
    for (let i = 0; i < 32; i++) await cache.write(page(`thread-${i}`));
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('covro-conversation-history');
      req.onsuccess = () => resolve(req.result);
    });
    const metadata = await new Promise<{ bytes: number; key: string; savedAt: number }[]>(
      (resolve) => {
        const req = db.transaction('metadata').objectStore('metadata').getAll();
        req.onsuccess = () => resolve(req.result);
      },
    );
    const latest = await cache.read('project', 'thread-31');
    const wrongUser = await new HistoryCache('other-user').read('project', 'thread-31');
    const wrongProject = await cache.read('other-project', 'thread-31');
    const wrongThread = await cache.read('project', 'other-thread');
    const tx = db.transaction('metadata', 'readwrite');
    for (const meta of metadata)
      tx.objectStore('metadata').put({ ...meta, version: 1, savedAt: 0 });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    const expired = await cache.read('project', 'thread-31');
    await cache.write(page('fresh'));
    await cache.write(page('fresh'), 'older');
    await cache.remove('project', 'fresh');
    const removed = await cache.read('project', 'fresh');
    const removedChunk = await cache.read('project', 'fresh', 'older');
    db.close();
    return {
      total: metadata.reduce((sum, entry) => sum + entry.bytes, 0),
      limit: HISTORY_CACHE_LIMIT,
      count: metadata.length,
      latestStatus: latest?.status,
      turnStatus: latest?.turns[0]?.status,
      latestManaged: latest?.managed,
      wrongUser,
      wrongProject,
      wrongThread,
      expired,
      removed,
      removedChunk,
    };
  });
  expect(result.total).toBeLessThanOrEqual(result.limit);
  expect(result.count).toBeLessThan(32);
  expect(result).toMatchObject({
    latestStatus: 'unknown',
    turnStatus: 'unknown',
    latestManaged: false,
    wrongUser: undefined,
    wrongProject: undefined,
    wrongThread: undefined,
    expired: undefined,
    removed: undefined,
    removedChunk: undefined,
  });
});
