import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type WebSocketRoute, type TestInfo } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';
import type { ThreadView } from '../../src/shared/types';

async function recordMetrics(testInfo: TestInfo, name: string, value: unknown) {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

export const historyPage = (
  start: number,
  end: number,
  olderCursor: string | null,
  id = 'history-one',
): ThreadView => ({
  id,
  projectId: 'fixture',
  cwd: '/test',
  source: 'appServer',
  title: '长会话 · 分片加载验证',
  managed: true,
  status: 'completed',
  historyVisible: true,
  actions: [],
  history: { olderCursor },
  turns: Array.from({ length: end - start }, (_, index) => {
    const n = start + index;
    return {
      id: `${id}-${n}`,
      threadId: id,
      status: 'completed',
      items: [
        {
          id: `user-${n}`,
          type: 'userMessage',
          text: `任务 ${n}：优化会话加载，保持阅读位置稳定。`,
        },
        {
          id: `agent-${n}`,
          type: 'agentMessage',
          text: `回复 ${n}\n\n${'这是一段用于验证滚动、历史加载与实时同步的会话内容。'.repeat(8)}`,
        },
      ],
    };
  }),
});
export async function mockHistory(page: Page, full = false, confirm = true) {
  let socketClient: WebSocketRoute;
  let sequence = 0;
  let initialRequests = 0;
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    socketClient = socket;
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'snapshot' && message.type !== 'error' && message.kind !== 'thread')
        socket.send(raw);
    });
  });
  await page.route('**/api/projects/fixture/threads*', (route) =>
    route.fulfill({
      json: {
        data: ['history-one', 'history-two'].map((id) => ({
          ...historyPage(24, 36, '24', id),
          pendingActionCount: 0,
        })),
        nextCursor: null,
        cursor: { serverEpoch: 'history-test', seq: 1 },
      },
    }),
  );
  await page.route('**/api/threads/*/metadata', (route) =>
    route.fulfill({
      json: historyPage(
        24,
        36,
        '24',
        route.request().url().includes('history-two') ? 'history-two' : 'history-one',
      ),
    }),
  );
  await page.route('**/api/threads/history-*', (route) => {
    initialRequests++;
    return route.fulfill({
      json: historyPage(
        full ? 0 : 24,
        full ? 125 : 36,
        full ? null : '24',
        route.request().url().endsWith('history-two') ? 'history-two' : 'history-one',
      ),
    });
  });
  await page.goto('/');
  if (confirm) await confirmCompatibility(page);
  const started = Date.now();
  await page.locator('[data-thread-id="history-one"]').click();
  await expect(page.locator('.turn')).toHaveCount(full ? 125 : 12);
  return {
    visibleMs: Date.now() - started,
    initialRequests,
    update: (thread: ThreadView) =>
      socketClient.send(
        JSON.stringify({
          type: 'snapshot',
          threadId: thread.id,
          data: thread,
          cursor: { serverEpoch: 'history-stream', seq: ++sequence },
        }),
      ),
  };
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('prefetches one page at a time, preserves the visible turn and stops at the end', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockHistory(page);
  const requests: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/threads/*/history?*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')!;
    requests.push(cursor);
    if (cursor === '24') await gate;
    await route.fulfill({
      json: cursor === '24' ? historyPage(12, 24, '12') : historyPage(0, 12, null),
    });
  });
  await page.screenshot({ path: testInfo.outputPath('initial-page.png') });
  await page.locator('.conversation-scroll').evaluate((box) => {
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 }));
    box.scrollTop = 0;
  });
  await expect(page.locator('.history-pagination')).toHaveAttribute('aria-busy', 'true');
  const anchor = page.locator('[data-turn-id="history-one-24"]');
  const before = await anchor.evaluate((element) => element.getBoundingClientRect().top);
  await page.screenshot({ path: testInfo.outputPath('loading-page.png') });
  expect(requests).toEqual(['24']);
  release();
  await expect(page.locator('.turn')).toHaveCount(24);
  expect(
    Math.abs((await anchor.evaluate((element) => element.getBoundingClientRect().top)) - before),
  ).toBeLessThan(3);
  await page.locator('.conversation-scroll').evaluate((box) => {
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 }));
    box.scrollTop = 0;
  });
  await expect(page.locator('.turn')).toHaveCount(36);
  await expect(page.locator('.history-pagination')).toHaveCount(0);
  await page.locator('.conversation-scroll').evaluate((box) => {
    box.scrollTop = box.scrollHeight;
  });
  await page.locator('.conversation-scroll').evaluate((box) => {
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 }));
    box.scrollTop = 0;
  });
  expect(requests).toEqual(['24', '12']);
  await page.screenshot({ path: testInfo.outputPath('history-complete.png') });
});

test('retries a failed page and ignores a late response after switching sessions', async ({
  page,
}, testInfo) => {
  await mockHistory(page);
  let fail = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/threads/*/history?*', async (route) => {
    if (fail)
      return route.fulfill({
        status: 503,
        json: {
          error: { code: 'UNAVAILABLE', message: '历史消息暂时无法读取，已加载内容仍可阅读。' },
        },
      });
    await gate;
    await route.fulfill({ json: historyPage(12, 24, '12') }).catch(() => {});
  });
  await page.locator('.conversation-scroll').evaluate((box) => {
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 }));
    box.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: '重试加载', exact: true })).toBeVisible();
  await expect(page.locator('.turn')).toHaveCount(12);
  await page.screenshot({ path: testInfo.outputPath('history-error.png') });
  fail = false;
  await page.getByRole('button', { name: '重试加载', exact: true }).click();
  await page.locator('[data-thread-id="history-two"]').click();
  await expect(page.locator('[data-turn-id="history-two-35"]')).toBeVisible();
  release();
  await expect(page.locator('.turn')).toHaveCount(12);
  await expect(page.locator('[data-turn-id^="history-one-"]')).toHaveCount(0);
});

async function expectCacheSaved(page: Page, minimum = 1) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('covro-conversation-history');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (!db.objectStoreNames.contains('metadata')) {
          db.close();
          return 0;
        }
        const count = await new Promise<number>((resolve) => {
          const req = db.transaction('metadata').objectStore('metadata').count();
          req.onsuccess = () => resolve(req.result);
        });
        db.close();
        return count;
      }),
    )
    .toBeGreaterThanOrEqual(minimum);
}

test('reopens and reloads from a cached page while reconciling server corrections', async ({
  page,
}, testInfo) => {
  await mockHistory(page);
  await expectCacheSaved(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let initialRequests = 0;
  await page.route('**/api/threads/history-one', async (route) => {
    initialRequests++;
    await gate;
    const next = historyPage(24, 37, '24');
    next.turns[11]!.items[1]!.text = '另一台设备已更新这条回复。';
    await route.fulfill({ json: next });
  });
  const start = Date.now();
  await page.reload();
  await expect(page.locator('.history-cache-notice')).toContainText('显示本机缓存');
  await expect(page.locator('.turn')).toHaveCount(12);
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  const cacheVisibleMs = Date.now() - start;
  await page.screenshot({ path: testInfo.outputPath('cached-syncing.png') });
  release();
  await expect(page.locator('.history-cache-notice')).toHaveCount(0);
  await expect(page.locator('.turn')).toHaveCount(13);
  await expect(page.getByText('另一台设备已更新这条回复。', { exact: true })).toBeVisible();
  expect(await page.locator('[data-turn-id="history-one-35"]').count()).toBe(1);
  expect(initialRequests).toBe(1);
  await recordMetrics(testInfo, 'cache-timing.json', {
    cacheVisibleMs,
    synchronizedMs: Date.now() - start,
    initialRequests,
  });
});

test('keeps cached reading available on network failure and drops it after access is revoked', async ({
  page,
}, testInfo) => {
  await mockHistory(page);
  await expectCacheSaved(page);
  await page.route('**/api/threads/history-one', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'UNAVAILABLE', message: '服务暂时不可达' } },
    }),
  );
  await page.reload();
  await expect(page.locator('.history-cache-notice')).toContainText('同步失败');
  await expect(page.locator('.turn')).toHaveCount(12);
  await page.screenshot({ path: testInfo.outputPath('cached-offline.png') });
  await page.route('**/api/threads/history-one', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'THREAD_NOT_FOUND', message: '会话已删除' } },
    }),
  );
  await page.getByRole('button', { name: '重新同步', exact: true }).click();
  await expect(page.locator('.history-cache-notice')).toHaveCount(0);
  await expect(page.locator('.turn')).toHaveCount(0);
});

test('treats corrupt cache as a miss and falls back when IndexedDB is unavailable', async ({
  page,
}) => {
  await mockHistory(page);
  await expectCacheSaved(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('covro-conversation-history');
      req.onsuccess = () => resolve(req.result);
    });
    const tx = db.transaction('pages', 'readwrite');
    const cursor = tx.objectStore('pages').openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (entry) {
        entry.update({ json: '{broken', digest: 'bad' });
        entry.continue();
      }
    };
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.reload();
  await expect(page.locator('.turn')).toHaveCount(12);
  await expect(page.locator('.history-cache-notice')).toHaveCount(0);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      get() {
        throw new Error('Storage disabled');
      },
    });
  });
  await page.reload();
  await expect(page.locator('.turn')).toHaveCount(12);
});

test('keeps a live response while an older page is loading and fits a mobile viewport', async ({
  page,
}, testInfo) => {
  const fixture = await mockHistory(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/threads/*/history?*', async (route) => {
    await gate;
    await route.fulfill({ json: historyPage(12, 24, '12') });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.conversation-scroll').evaluate((box) => {
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 }));
    box.scrollTop = 0;
  });
  await expect(page.locator('.history-pagination')).toHaveAttribute('aria-busy', 'true');
  const live = historyPage(24, 37, '24');
  live.status = 'running';
  live.turns.at(-1)!.status = 'running';
  live.turns.at(-1)!.items[1]!.text = '实时输出在历史加载期间持续更新。';
  fixture.update(live);
  await expect(page.locator('.turn')).toHaveCount(13);
  release();
  await expect(page.locator('.turn')).toHaveCount(25);
  await expect(page.getByText('实时输出在历史加载期间持续更新。', { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('history-mobile.png') });
});

test('records first-content latency and initial payload for full versus paged history', async ({
  page,
  context,
}, testInfo) => {
  const full = await mockHistory(page, true);
  const other = await context.newPage();
  await other.addInitScript(() => {
    localStorage.removeItem('codex-web.selected:fixture');
  });
  const paged = await mockHistory(other, false, false);
  await recordMetrics(testInfo, 'first-content-comparison.json', {
    fixture:
      '125 turns, production UI, HTTP/WS history routes controlled by Playwright; local rendering only',
    full: {
      visibleMs: full.visibleMs,
      requests: full.initialRequests,
      turns: 125,
      bytes: Buffer.byteLength(JSON.stringify(historyPage(0, 125, null))),
    },
    paged: {
      visibleMs: paged.visibleMs,
      requests: paged.initialRequests,
      turns: 12,
      bytes: Buffer.byteLength(JSON.stringify(historyPage(24, 36, '24'))),
    },
  });
});

test('reads further cached history without network requests after failure, then reconciles all opened pages', async ({
  page,
}, testInfo) => {
  await mockHistory(page);
  let unavailable = false;
  const requests: string[] = [];
  await page.route('**/api/threads/*/history?*', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')!;
    requests.push(cursor);
    return unavailable
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'UNAVAILABLE', message: '历史同步暂时不可用' } },
        })
      : route.fulfill({
          json: cursor === '24' ? historyPage(12, 24, '12') : historyPage(0, 12, null),
        });
  });
  const toTop = () =>
    page.locator('.conversation-scroll').evaluate((box) => {
      box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 }));
      box.scrollTop = 0;
    });
  await toTop();
  await expect(page.locator('.turn')).toHaveCount(24);
  await toTop();
  await expect(page.locator('.turn')).toHaveCount(36);
  await expectCacheSaved(page, 3);
  unavailable = true;
  await page.route('**/api/threads/history-one', (route) =>
    unavailable
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'UNAVAILABLE', message: '服务暂时不可达' } },
        })
      : route.fulfill({ json: historyPage(24, 36, '24') }),
  );
  await page.reload();
  await expect(page.locator('.history-cache-notice')).toContainText('同步失败');
  await toTop();
  await expect(page.getByRole('button', { name: '继续读取本机历史', exact: true })).toBeVisible();
  await expect(page.locator('.turn')).toHaveCount(24);
  await toTop();
  await page.screenshot({ path: testInfo.outputPath('cached-history-offline.png') });
  const before = requests.length;
  await page.getByRole('button', { name: '继续读取本机历史', exact: true }).click();
  await expect(page.locator('.turn')).toHaveCount(36);
  expect(requests.length).toBe(before);
  unavailable = false;
  await page.getByRole('button', { name: '重新同步', exact: true }).click();
  await expect(page.locator('.history-cache-notice')).toHaveCount(0);
  await expect(page.locator('.turn')).toHaveCount(36);
  expect(requests.slice(before)).toEqual(['24', '12']);
});
