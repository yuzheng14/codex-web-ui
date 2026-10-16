import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

test('compact uses its own task and the same conversation remains usable', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  const input = page.getByRole('textbox', { name: /^(任务内容|追加要求)$/ });
  await input.fill('请概括这个项目的主要结构。');
  await input.press('Enter');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  const outgoing: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') outgoing.push(req.url());
  });
  await input.fill('/compact');
  await input.press('Enter');
  await expect(page.locator('.slash-feedback')).toContainText('已提交上下文压缩请求');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  const activities = page.locator('.turn').last().locator('details.activity-group');
  await expect(activities).not.toHaveAttribute('open');
  await expect(activities.locator(':scope > summary')).toContainText('已完成 1');
  await activities.locator(':scope > summary').click();
  await expect(page.getByText('压缩上下文', { exact: true })).toBeVisible();
  expect(outgoing.filter((url) => url.endsWith('/compact'))).toHaveLength(1);
  expect(outgoing.filter((url) => url.endsWith('/turns'))).toHaveLength(0);
  await expect(page.locator('.user-message')).not.toContainText('/compact');
  await page.getByText('压缩上下文', { exact: true }).click();
  await page.getByText('上下文压缩已结束。', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/slash-compact-result.png', fullPage: true });
  await input.fill('/compact');
  await page.screenshot({
    path: process.env.COMPACT_SCREENSHOT ?? '/tmp/slash-compact.png',
    fullPage: true,
  });
  await input.fill('继续说明测试结构。');
  await input.press('Enter');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
});
