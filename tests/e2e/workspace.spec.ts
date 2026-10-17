import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ThreadPage } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  expectThreadReady,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

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
  await confirmCompatibility(page);
  await expect(page.getByText('模拟测试模式', { exact: false })).toBeVisible();
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await createThreadButton(page).click();
  await expectThreadReady(page);
}

test('complete turn, tool output, file diff and refresh recover through the real gateway', async ({
  page,
}) => {
  await newThread(page);
  await page.getByRole('textbox', { name: '任务内容' }).fill('创建一个简单的问候文件');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await expect(page.locator('details.activity-group')).not.toHaveAttribute('open');
  await page.locator('details.activity-group > summary').click();
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
  await expect(
    page.locator('.conversation-content').getByText('创建一个简单的问候文件', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: '/tmp/codex-web-desktop.png', fullPage: true });
});

test('task and steer preserve whitespace through approval, reconnect and multi-question flow', async ({
  page,
  context,
}) => {
  await newThread(page);
  const task = '    [approval] 请保留下面代码块的首行缩进：\n        print("你好")\n';
  const taskRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && /\/api\/threads\/[^/]+\/turns$/.test(request.url()),
  );
  await page.getByRole('textbox', { name: '任务内容' }).fill(task);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  expect((await taskRequest).postDataJSON().text).toBe(task);
  await expect(page.locator('.action-card')).toBeVisible();
  await expect(page.locator('.user-text').first()).toHaveJSProperty('textContent', task);

  // The pending approval keeps the same turn active while we send an additional requirement.
  const steerInput = page.getByRole('textbox', { name: '追加要求', exact: true });
  await steerInput.fill('  \n\t\n');
  await expect(page.getByRole('button', { name: '追加要求', exact: true })).toBeDisabled();
  const steer = '    追加：不要移除以下内容的缩进或末尾换行。\n        return "完成"\n';
  const steerRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && /\/api\/threads\/[^/]+\/steer$/.test(request.url()),
  );
  await steerInput.fill(steer);
  await page.getByRole('button', { name: '追加要求', exact: true }).click();
  expect((await steerRequest).postDataJSON().text).toBe(steer);
  await expect(page.locator('.user-text').nth(1)).toHaveJSProperty('textContent', steer);
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(page.locator('.action-card')).toBeVisible();
  await expect(page.locator('.user-text').first()).toHaveJSProperty('textContent', task);
  await expect(page.locator('.user-text').nth(1)).toHaveJSProperty('textContent', steer);
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
  await confirmCompatibility(page);
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await createThreadButton(page).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
  await expectThreadReady(page);
  const input = page.getByRole('textbox', { name: '任务内容' });
  await input.fill('输入法组合期间保留草稿');
  await input.dispatchEvent('compositionstart');
  // Synthetic composition events do not activate the browser's native IME.
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(input).toHaveValue('输入法组合期间保留草稿');
  await expect(page.locator('.turn')).toHaveCount(0);
  await input.dispatchEvent('compositionend');
  await input.dispatchEvent('keyup', { key: 'Enter' });
  await input.press('Enter');
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
  await expect(
    page.locator('.conversation-content').getByText('提交回执丢失的任务', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toHaveCount(1);
  expect(submissions).toBe(1);
});
