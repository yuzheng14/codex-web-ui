import { expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';
import type { ThreadView } from '../../src/shared/types';

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
export async function mockHistory(page: Page) {
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
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
  await page.route('**/api/threads/history-*', (route) =>
    route.fulfill({
      json: historyPage(
        24,
        36,
        '24',
        route.request().url().endsWith('history-two') ? 'history-two' : 'history-one',
      ),
    }),
  );
  await page.goto('/');
  await confirmCompatibility(page);
  await page.locator('[data-thread-id="history-one"]').click();
  await expect(page.locator('.turn')).toHaveCount(12);
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
