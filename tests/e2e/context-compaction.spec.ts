import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

const evidence = join(tmpdir(), 'codex-compaction-evidence');
const notice = (page: Page) => page.getByTestId('context-compaction');
const turnStatus = (page: Page) => page.locator('.turn-heading .status').last();
async function start(page: Page, outcome: string, history = '') {
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill(`[context-compact-${outcome}] 继续梳理项目结构，并完善剩余测试。${history}`);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(notice(page)).toHaveAttribute('data-state', 'inProgress');
  await expect(notice(page)).toHaveCount(1);
  await expect(page.locator('.turn').last().locator('details.activity-group')).toHaveCount(0);
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}
async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}
test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
});
test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
});
for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name}: compaction completes before the task and stays out of tool groups`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await start(page, 'recover');
    await expect(notice(page)).toBeInViewport();
    await screenshot(page, `02-compacting-${viewport.name}`);
    await expect(notice(page)).toHaveAttribute('data-state', 'completed');
    await expect(notice(page)).toHaveText('上下文已压缩');
    await expect(
      page.getByText('已整理上下文，继续分析剩余实现与测试。', { exact: true }),
    ).toBeVisible();
    await expect(turnStatus(page)).toHaveText('执行中');
    await expect(page.locator('.context-compaction-pinned')).toHaveCount(0);
    await screenshot(page, `03-resumed-${viewport.name}`);
    await expect(turnStatus(page)).toHaveText('已完成');
    await page.reload();
    await expect(notice(page)).toHaveAttribute('data-state', 'completed');
    await expect(notice(page)).toHaveCount(1);
  });
  test(`${viewport.name}: failure and interruption stop the indicator and explain the outcome`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await start(page, 'fail');
    await expect(notice(page)).toHaveAttribute('data-state', 'failed');
    await expect(notice(page)).toContainText('模型服务暂时不可用');
    await expect(turnStatus(page)).toHaveText('失败');
    await screenshot(page, `04-failed-${viewport.name}`);
    await page.reload();
    await expect(notice(page)).toHaveAttribute('data-state', 'failed');
    // Start another turn in this same thread: the old failure stays historical.
    await page
      .getByRole('textbox', { name: '任务内容', exact: true })
      .fill('[context-compact-hold] 继续任务');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.context-compaction-pinned')).toBeVisible();
    await page.getByRole('button', { name: '中断', exact: true }).click();
    await expect(turnStatus(page)).toHaveText('已中断');
    await expect(page.locator('.context-compaction-pinned')).toHaveCount(0);
    await expect(notice(page).last()).toHaveAttribute('data-state', 'interrupted');
    await screenshot(page, `05-interrupted-${viewport.name}`);
  });
}
test('reload, disconnect and switching threads retain only the matching known live state', async ({
  page,
  context,
}) => {
  const id = await start(page, 'hold', '\n已确认的历史信息。'.repeat(80));
  await page.reload();
  await expect(notice(page)).toHaveAttribute('data-state', 'inProgress');
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await expect(notice(page)).toContainText('上次已知');
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(notice(page)).not.toContainText('上次已知');
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await page.locator(`[data-thread-id="${id}"]`).click();
  await expect(notice(page)).toHaveAttribute('data-state', 'inProgress');
  // Scrolling genuinely overflowing history cannot hide the fixed compaction status.
  expect(
    await page
      .locator('.conversation-scroll')
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  await page.locator('.conversation-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(notice(page)).toBeInViewport();
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(notice(page)).toHaveAttribute('data-state', 'interrupted');
  await page.reload();
  await expect(notice(page)).toHaveAttribute('data-state', 'interrupted');
});

test('normal model work never starts compaction and runtime loss stops a known spinner', async ({
  page,
  request,
}) => {
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[codex-thinking] 分析任务');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.activity-label')).toContainText(['思考过程']);
  await expect(notice(page)).toHaveCount(0);
  await expect(turnStatus(page)).toHaveText('已完成');
  await expect(notice(page)).toHaveCount(0);
  await start(page, 'hold');
  await controlRuntime(request, { unavailable: true });
  await expect(page.locator('.context-compaction-pinned')).toHaveCount(0);
  await expect(notice(page)).toHaveAttribute('data-state', 'unknown');
  await expect(notice(page)).toContainText('未收到明确的完成结果');
});
