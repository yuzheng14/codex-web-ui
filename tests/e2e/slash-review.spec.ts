import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  expectThreadReady,
} from './helpers';
import type { ThreadView } from '../../src/shared/types';

const input = (page: Page) => page.getByRole('textbox', { name: /^(任务内容|追加要求)$/ });
const origin = 'http://127.0.0.1:8788';
async function create(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expectThreadReady(page);
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('native review completes in the current conversation, persists results, and sends no prompt', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  const threadId = await create(page);
  const writes: Request[] = [];
  page.on('request', (entry) => {
    if (entry.method() === 'POST') writes.push(entry);
  });
  await input(page).fill('/review');
  await expect(page.getByRole('option', { name: /^\/review\b/ })).toContainText('未提交改动');
  await page.screenshot({ path: '/tmp/slash-review-menu.png', fullPage: true });
  await input(page).press('Enter');
  await expect(page.locator('.slash-feedback')).toHaveText(
    '已提交代码审查，请在当前会话查看进度和结果。',
  );
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.getByRole('heading', { name: '代码审查结果', exact: true })).toBeVisible();
  await expect(page.locator('.turn').last().locator('details.activity-group')).not.toHaveAttribute(
    'open',
  );
  await expect(page.getByText('模拟审查已完成：未提交改动中未发现需要修复的问题。')).toBeVisible();
  expect(writes.filter((entry) => entry.url().endsWith('/review'))).toHaveLength(1);
  expect(writes.some((entry) => /\/(turns|steer)$/.test(entry.url()))).toBe(false);
  await page.screenshot({ path: '/tmp/slash-review-result.png', fullPage: true });
  await page.reload();
  await expect(page.getByRole('heading', { name: '代码审查结果', exact: true })).toBeVisible();
  await expect(page.locator('.turn').last().locator('details.activity-group')).not.toHaveAttribute(
    'open',
  );
  const history = (await (await request.get(`/api/threads/${threadId}`)).json()) as ThreadView;
  expect(history.turns).toHaveLength(1);
  expect(history.turns[0]!.items.some((item) => item.type === 'userMessage')).toBe(false);
  expect(history.execution).toBeUndefined();
});

test('rejects custom review inputs and retains the draft after an unsuccessful receipt', async ({
  page,
  request,
}) => {
  const threadId = await create(page);
  const invalid = await request.post(`/api/threads/${threadId}/review`, {
    headers: { Origin: origin },
    data: { clientOperationId: randomUUID(), target: { type: 'custom', instructions: 'no' } },
  });
  expect(invalid.status()).toBe(400);
  await input(page).fill('/review custom instructions');
  await input(page).press('Enter');
  await expect(page.locator('.slash-feedback')).toContainText('不接受参数');
  await expect(input(page)).toHaveValue('/review custom instructions');
  await page.route('**/api/threads/*/review', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'NO_GIT_REPOSITORY', message: '当前目录不是 Git 仓库' },
      }),
    }),
  );
  await input(page).fill('/review');
  await input(page).press('Enter');
  await expect(page.locator('.slash-feedback')).toHaveAttribute('role', 'alert');
  await expect(input(page)).toHaveValue('/review');
  await expect(
    page.getByRole('alert').filter({ hasText: '当前目录不是 Git 仓库' }),
  ).toBeVisible();
  expect(
    ((await (await request.get(`/api/threads/${threadId}`)).json()) as ThreadView).turns,
  ).toHaveLength(0);
});

test('blocks a second review while running and uses normal interruption for its actual turn', async ({
  page,
  request,
}) => {
  const threadId = await create(page);
  // Delay only the HTTP receipt: the real native review and events still execute once.
  await page.route('**/api/threads/*/review', async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response });
  });
  await input(page).fill('/review');
  await input(page).press('Enter');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('执行中');
  await input(page).press('Enter');
  const history = (await (await request.get(`/api/threads/${threadId}`)).json()) as ThreadView;
  const interrupted = await request.post(`/api/threads/${threadId}/interrupt`, {
    headers: { Origin: origin },
    data: { clientOperationId: randomUUID(), expectedTurnId: history.turns[0]!.id },
  });
  expect(interrupted.ok()).toBe(true);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已中断');
  await expect(input(page)).toHaveValue('');
  expect(
    ((await (await request.get(`/api/threads/${threadId}`)).json()) as ThreadView).turns,
  ).toHaveLength(1);
});
