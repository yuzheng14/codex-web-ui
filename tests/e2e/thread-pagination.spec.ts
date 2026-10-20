import { expect, test, type Page } from '@playwright/test';
import type { ThreadSummary, ThreadSummaryPage } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, projectGroup } from './helpers';

const thread = (
  id: string,
  title: string,
  projectId = 'fixture',
  archived = false,
): ThreadSummary => ({
  id,
  title,
  projectId,
  archived,
  source: 'appServer',
  managed: false,
  status: 'idle',
  pendingActionCount: 0,
});
const pageOf = (data: ThreadSummary[], nextCursor: string | null): ThreadSummaryPage => ({
  data,
  nextCursor,
  cursor: { serverEpoch: 'pagination-fixture', seq: 1 },
});
const more = (page: Page) =>
  projectGroup(page).getByRole('button', { name: '加载更多会话', exact: true });
const row = (page: Page, id: string) => page.locator(`[data-thread-id="${id}"]`);

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('one click skips empty and duplicate pages, prevents duplicate requests and clears terminal loading', async ({
  page,
}, testInfo) => {
  const requests: (string | null)[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const existing = thread('old', '优化会话列表分页');
  const added = thread('new', '验证空页与分页结束');
  await page.route('**/api/projects/fixture/threads*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    requests.push(cursor);
    if (cursor === 'empty') await gate;
    const result =
      cursor === null
        ? pageOf([existing], 'empty')
        : cursor === 'empty'
          ? pageOf([], 'duplicate')
          : cursor === 'duplicate'
            ? pageOf([existing], 'new-page')
            : cursor === 'new-page'
              ? pageOf([added, existing], 'last')
              : pageOf([], null);
    await route.fulfill({ json: result });
  });
  await open(page);
  await expect(more(page)).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('pagination-more.png') });
  await more(page).dblclick();
  const loading = projectGroup(page).getByRole('button', {
    name: '正在加载更多会话…',
    exact: true,
  });
  await expect(loading).toBeDisabled();
  await expect(projectGroup(page).getByText('正在读取会话…', { exact: true })).toHaveCount(0);
  await expect(row(page, 'old')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pagination-loading.png') });
  expect(requests.filter((cursor) => cursor === 'empty')).toHaveLength(1);
  release();
  await expect(row(page, 'new')).toBeVisible();
  await expect(row(page, 'old')).toHaveCount(1);
  await more(page).click();
  await expect(projectGroup(page).getByText('已加载全部会话', { exact: true })).toBeVisible();
  await expect(more(page)).toHaveCount(0);
  await expect(loading).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('pagination-complete.png') });
  // Initial boot and the overview WebSocket can both refresh the first page.
  expect(requests.filter((cursor) => cursor !== null)).toEqual([
    'empty',
    'duplicate',
    'new-page',
    'last',
  ]);
});

test('a failed append is retryable from the same cursor without losing earlier pages', async ({
  page,
}, testInfo) => {
  const requests: (string | null)[] = [];
  let failed = false;
  await page.route('**/api/projects/fixture/threads*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    requests.push(cursor);
    if (cursor === 'last' && !failed) {
      failed = true;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: '会话读取暂时失败' } },
      });
    }
    await route.fulfill({
      json:
        cursor === null
          ? pageOf([thread('one', '第一页')], 'second')
          : cursor === 'second'
            ? pageOf([thread('two', '第二页')], 'last')
            : pageOf([thread('three', '第三页')], null),
    });
  });
  await open(page);
  await more(page).click();
  await expect(row(page, 'two')).toBeVisible();
  await more(page).click();
  await expect(
    projectGroup(page).getByRole('button', { name: '加载失败，重试', exact: true }),
  ).toHaveAccessibleDescription(/服务暂时不可用/);
  await expect(more(page)).toHaveCount(0);
  await expect(projectGroup(page).getByText('正在读取会话…')).toHaveCount(0);
  await expect(row(page, 'one')).toBeVisible();
  await expect(row(page, 'two')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pagination-error.png') });
  await projectGroup(page).getByRole('button', { name: '加载失败，重试', exact: true }).click();
  await expect(row(page, 'three')).toBeVisible();
  await expect(row(page, 'one')).toBeVisible();
  await expect(row(page, 'two')).toBeVisible();
  expect(requests.filter((cursor) => cursor !== null)).toEqual(['second', 'last', 'last']);
});

test('a repeated cursor ends loading with an error instead of offering endless empty clicks', async ({
  page,
}) => {
  await page.route('**/api/projects/fixture/threads*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    await route.fulfill({
      json: cursor === null ? pageOf([thread('one', '已有会话')], 'stuck') : pageOf([], 'stuck'),
    });
  });
  await open(page);
  await more(page).click();
  await expect(
    projectGroup(page).getByRole('button', { name: '加载失败，重试', exact: true }),
  ).toHaveAccessibleDescription('会话分页游标未前进，请重试或刷新会话列表。');
  await expect(projectGroup(page).getByRole('button', { name: '加载失败，重试' })).toBeEnabled();
  await expect(more(page)).toHaveCount(0);
  await expect(projectGroup(page).getByText('已加载全部会话')).toHaveCount(0);
  await expect(row(page, 'one')).toBeVisible();
});

test('archive switches and refreshes invalidate delayed pages while projects retain independent cursors', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: string[] = [];
  await page.route('**/api/projects/*/threads*', async (route) => {
    const url = new URL(route.request().url());
    const projectId = url.pathname.includes('/fixture-other/') ? 'fixture-other' : 'fixture';
    const cursor = url.searchParams.get('cursor');
    const archived = url.searchParams.has('archived');
    requests.push(`${projectId}:${archived}:${cursor}`);
    if (cursor === 'active-more') await gate;
    await route.fulfill({
      json: archived
        ? pageOf([thread(`archived-${projectId}`, '已归档会话', projectId, true)], null)
        : cursor
          ? pageOf([thread('late', '过期响应', projectId)], null)
          : pageOf(
              [thread(`active-${projectId}`, '当前会话', projectId)],
              projectId === 'fixture' ? 'active-more' : 'other-more',
            ),
    });
  });
  await open(page);
  await more(page).click();
  await page.getByRole('button', { name: '已归档会话', exact: true }).click();
  await expect(row(page, 'archived-fixture')).toBeVisible();
  release();
  await expect(row(page, 'late')).toHaveCount(0);
  await expect(row(page, 'active-fixture')).toHaveCount(0);
  await expect(more(page)).toHaveCount(0);
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(row(page, 'active-fixture')).toBeVisible();
  await expect(more(page)).toBeEnabled();
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '加载更多会话', exact: true })
    .click();
  await expect(projectGroup(page, '另一个项目').getByText('已加载全部会话')).toBeVisible();
  await expect(more(page)).toBeEnabled();
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await expect(
    projectGroup(page, '另一个项目').getByRole('button', { name: '加载更多会话', exact: true }),
  ).toBeEnabled();
  expect(requests).toContain('fixture-other:false:other-more');
});
