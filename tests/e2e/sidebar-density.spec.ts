import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Operation, RunStatus, ThreadSummary } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, projectGroup } from './helpers';

const headers = { Origin: 'http://127.0.0.1:8788' };
const longTitle =
  '完整会话标题：检查来自 Web UI 的会话来源、键盘访问与触屏详情，确保省略的内容仍可阅读';
const link = (page: Page, id: string) => page.locator(`[data-thread-id="${id}"]`);
const threadRow = (page: Page, id: string) => link(page, id).locator('..');

async function submit(request: APIRequestContext, path: string, data: object = {}) {
  const response = await request.post(path, {
    headers,
    data: { clientOperationId: randomUUID(), ...data },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Operation;
}

async function create(request: APIRequestContext, title: string, project = 'fixture') {
  const operation = await submit(request, `/api/projects/${project}/threads`);
  const { threadId } = operation.result as { threadId: string };
  await submit(request, `/api/threads/${threadId}/rename`, { name: title });
  return threadId;
}

async function open(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('compact rows retain keyboard-accessible full titles and creation details', async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  for (let index = 0; index < 34; index++)
    await create(request, `会话 ${index + 1}：检查项目配置与运行结果`);
  const id = await create(request, longTitle);
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await expect(projectGroup(page).locator('[data-thread-id]')).toHaveCount(35);
  await page.locator('.project-list').evaluate((element) => {
    element.scrollTop = 0;
  });

  const metrics = await page.locator('.project-list').evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll('[data-thread-id]')].map((row) =>
      row.getBoundingClientRect(),
    );
    return {
      visibleRows: rows.filter((row) => row.top >= viewport.top && row.bottom <= viewport.bottom)
        .length,
      maximumHeight: Math.max(...rows.map((row) => row.height)),
    };
  });
  // At the same 1280×900 viewport the former three-line rows fit only four conversations.
  expect(metrics.visibleRows).toBeGreaterThanOrEqual(9);
  expect(metrics.maximumHeight).toBeLessThanOrEqual(40);
  const rowBounds = await link(page, id).boundingBox();
  expect(rowBounds).not.toBeNull();
  for (const button of await threadRow(page, id).locator('.thread-row-actions button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(rowBounds!.y);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(rowBounds!.y + rowBounds!.height);
  }
  await expect(link(page, id).locator('.thread-progress')).toHaveCount(0);
  const title = link(page, id).locator('.thread-title');
  expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(title).toHaveCSS('text-overflow', 'ellipsis');
  const compact = testInfo.outputPath('sidebar-compact-desktop.png');
  await page.screenshot({ path: compact, animations: 'disabled' });
  await testInfo.attach('sidebar-compact-desktop', { path: compact, contentType: 'image/png' });
  await testInfo.attach('sidebar-density', {
    body: JSON.stringify(metrics),
    contentType: 'application/json',
  });

  const detailsButton = page.getByRole('button', { name: `会话详情：${longTitle}`, exact: true });
  await detailsButton.focus();
  await expect(detailsButton).toBeFocused();
  await detailsButton.press('Enter');
  await expect(detailsButton).toHaveAttribute('aria-expanded', 'true');
  const details = threadRow(page, id).locator('.thread-details');
  await expect(details).toBeVisible();
  await expect(details).toContainText(longTitle);
  await expect(details).toContainText('Web');
  await expect(details).toContainText('由 Codex Web UI（本网页）创建。');
  await expect(details).toContainText('就绪');
  await expect(link(page, id)).not.toHaveAttribute('aria-current', 'page');
  const expanded = testInfo.outputPath('sidebar-details-keyboard.png');
  await page.screenshot({ path: expanded, animations: 'disabled' });
  await testInfo.attach('sidebar-details-keyboard', { path: expanded, contentType: 'image/png' });
  await detailsButton.press('Space');
  await expect(detailsButton).toHaveAttribute('aria-expanded', 'false');
  await expect(details).not.toBeVisible();

  await page.route('**/api/projects/fixture/threads*', async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    await route.fulfill({
      response,
      json: {
        ...result,
        data: result.data.map((thread: ThreadSummary) =>
          thread.id === id ? { ...thread, originator: null, source: 'vscode' } : thread,
        ),
      },
    });
  });
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await detailsButton.click();
  await expect(details).toContainText('交互客户端');
  await expect(details).toContainText('无法确认具体创建客户端');
  await detailsButton.press('Escape');
  await expect(detailsButton).toBeFocused();
  await expect(details).not.toBeVisible();
});

test('critical execution states stay visible while ordinary completion moves into details', async ({
  page,
  request,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  const states: {
    status: RunStatus;
    label: string;
    lastTurnStatus?: RunStatus;
    pending?: number;
  }[] = [
    { status: 'running', label: '执行中' },
    { status: 'waitingApproval', label: '等待审批', pending: 2 },
    { status: 'waitingInput', label: '等待回答', pending: 1 },
    { status: 'idle', lastTurnStatus: 'failed', label: '失败' },
    { status: 'idle', lastTurnStatus: 'interrupted', label: '已中断' },
    { status: 'unknown', label: '状态待核对' },
    { status: 'idle', lastTurnStatus: 'completed', label: '已完成' },
  ];
  const ids = await Promise.all(
    states.map((state, index) => create(request, `${index + 1} · ${state.label}的会话`)),
  );
  // Keep real gateway identities and navigation while covering all persisted summary states.
  await page.route('**/api/projects/fixture/threads*', async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    await route.fulfill({
      response,
      json: {
        ...result,
        data: result.data.map((thread: ThreadSummary) => {
          const state = states[ids.indexOf(thread.id)];
          return state
            ? {
                ...thread,
                status: state.status,
                lastTurnStatus: state.lastTurnStatus,
                pendingActionCount: state.pending ?? 0,
              }
            : thread;
        }),
      },
    });
  });
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  for (const [index, state] of states.entries()) {
    const progress = link(page, ids[index]!).locator('.thread-progress');
    if (state.lastTurnStatus === 'completed') await expect(progress).toHaveCount(0);
    else {
      await expect(progress).toBeVisible();
      await expect(progress).toContainText(state.label);
    }
  }
  await expect(link(page, ids[1]!)).toContainText('2 项待处理');
  await expect(link(page, ids[2]!)).toContainText('1 项待处理');
  await link(page, ids[0]!).scrollIntoViewIfNeeded();
  const statesScreenshot = testInfo.outputPath('sidebar-critical-states.png');
  await page.screenshot({ path: statesScreenshot, animations: 'disabled' });
  await testInfo.attach('sidebar-critical-states', {
    path: statesScreenshot,
    contentType: 'image/png',
  });
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  for (const id of ids.slice(0, 3))
    await expect(link(page, id).locator('.thread-progress')).toContainText('上次已知：');
});

test.describe('touch navigation', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('touch details, search, switching and loading another page stay usable', async ({
    page,
    request,
  }, testInfo) => {
    await open(page);
    const first = await create(request, longTitle);
    const second = await create(request, '第二页：继续核对创建来源');
    let pageReads = 0;
    await page.route('**/api/projects/fixture/threads*', async (route) => {
      pageReads++;
      const response = await route.fetch();
      const result = await response.json();
      const more = new URL(route.request().url()).searchParams.has('cursor');
      await route.fulfill({
        response,
        json: {
          ...result,
          data: result.data.filter(
            (thread: ThreadSummary) => thread.id === (more ? second : first),
          ),
          nextCursor: more ? null : 'sidebar-second-page',
        },
      });
    });
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await page.getByRole('button', { name: '刷新会话列表' }).tap();
    await expect(link(page, first)).toBeVisible();
    await expect(link(page, second)).toHaveCount(0);
    const detailsButton = page.getByRole('button', { name: `会话详情：${longTitle}`, exact: true });
    await detailsButton.tap();
    await expect(threadRow(page, first).locator('.thread-details')).toContainText(longTitle);
    await expect(detailsButton).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await threadRow(page, first).evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const screenshot = testInfo.outputPath('sidebar-details-touch.png');
    await page.screenshot({ path: screenshot, animations: 'disabled' });
    await testInfo.attach('sidebar-details-touch', { path: screenshot, contentType: 'image/png' });
    await detailsButton.tap();
    await projectGroup(page).getByRole('button', { name: '加载更多会话', exact: true }).tap();
    await expect(link(page, second)).toBeVisible();
    const search = page.getByRole('searchbox', { name: '搜索项目与已加载会话' });
    await search.fill('第二页');
    await expect(link(page, first)).toHaveCount(0);
    await expect(link(page, second)).toBeVisible();
    await link(page, second).tap();
    await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
    await expect(page.locator('.topbar h1')).toHaveText('第二页：继续核对创建来源');
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await search.fill('');
    const before = pageReads;
    await projectGroup(page, '另一个项目')
      .getByRole('button', { name: '另一个项目', exact: true })
      .tap();
    await projectGroup(page).getByRole('button', { name: '测试项目', exact: true }).tap();
    await expect(link(page, first)).toBeVisible();
    await expect(link(page, second)).toBeVisible();
    await expect(
      projectGroup(page).getByRole('button', { name: '加载更多会话', exact: true }),
    ).toHaveCount(0);
    expect(pageReads).toBe(before);
  });
});
