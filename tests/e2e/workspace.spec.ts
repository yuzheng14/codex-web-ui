import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ThreadPage } from '../../src/shared/types';

test.afterEach(async ({ request }) => {
  const response = await request.get('/api/threads?projectId=fixture');
  if (!response.ok()) return;
  const page = (await response.json()) as ThreadPage;
  for (const thread of page.data) {
    const turn = thread.turns.find((entry) =>
      ['running', 'waitingApproval', 'waitingInput'].includes(entry.status),
    );
    if (turn)
      await request.post(`/api/threads/${encodeURIComponent(thread.id)}/interrupt`, {
        headers: { Origin: 'http://127.0.0.1:8788' },
        data: { clientOperationId: randomUUID(), expectedTurnId: turn.id },
      });
  }
});

async function newThread(page: Page) {
  await page.goto('/');
  await expect(page.getByText('模拟测试模式', { exact: false })).toBeVisible();
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
}

test('complete turn, tool output, file diff and refresh recover through the real gateway', async ({
  page,
}) => {
  await newThread(page);
  await page.getByRole('textbox', { name: '任务内容' }).fill('创建一个简单的问候文件');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await page
    .locator('details.activity')
    .filter({ hasText: '执行命令' })
    .locator('summary')
    .first()
    .click();
  await expect(page.locator('.tool-output')).toContainText('你好 Codex');
  await page
    .locator('details.activity')
    .filter({ hasText: '文件变更' })
    .locator('summary')
    .first()
    .click();
  await expect(page.locator('.file-change')).toContainText('hello.txt');
  await expect(page.locator('.file-change')).toContainText('+你好 Codex');
  await page.reload();
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await expect(page.getByText('创建一个简单的问候文件', { exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/codex-web-desktop.png', fullPage: true });
});

test('approval survives disconnect and multi-question answers respect options', async ({
  page,
  context,
}) => {
  await newThread(page);
  await page.getByRole('textbox', { name: '任务内容' }).fill('[approval] 请运行需要确认的命令');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(page.locator('.action-card')).toBeVisible();
  await page.locator('.action-options button').first().click();
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await page.getByRole('textbox', { name: '任务内容' }).fill('[questions] 请确认偏好');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByRole('radio', { name: '深色', exact: false }).check();
  await page.locator('.action-card input[type="text"]').fill('我的项目');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toHaveCount(2);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
});

test('mobile navigation and input shortcuts preserve a draft during IME composition', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByRole('button', { name: '关闭导航', exact: true }).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  const input = page.getByRole('textbox', { name: '任务内容' });
  await input.fill('输入法组合期间保留草稿');
  await input.dispatchEvent('compositionstart');
  await input.press('Control+Enter');
  await expect(input).toHaveValue('输入法组合期间保留草稿');
  await expect(page.locator('.turn')).toHaveCount(0);
  await input.dispatchEvent('compositionend');
  await input.press('Control+Enter');
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: '/tmp/codex-web-mobile.png', fullPage: true });
});

test('a lost HTTP receipt queries the durable operation without replaying the prompt', async ({
  page,
}) => {
  await newThread(page);
  let submissions = 0;
  await page.route('**/api/threads/*/turns', async (route) => {
    submissions++;
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('textbox', { name: '任务内容' }).fill('提交回执丢失的任务');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await page.reload();
  await expect(page.getByText('提交回执丢失的任务', { exact: true })).toHaveCount(1);
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toHaveCount(1);
  expect(submissions).toBe(1);
});
