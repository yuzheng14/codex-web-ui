import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  createThreadButton,
  projectGroup,
  saveConversationHistory,
  expectThreadReady,
} from './helpers';
import type { ThreadView } from '../../src/shared/types';

const input = (page: Page) => page.getByRole('textbox', { name: /^(任务内容|追加要求)$/ });
const feedback = (page: Page) => page.locator('.slash-feedback');
const selected = (page: Page) =>
  page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
async function create(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expectThreadReady(page);
  return (await selected(page))!;
}

test.beforeEach(async ({ request, baseURL }) => {
  // Derive the test-only control port so this suite also runs in an isolated worktree.
  const control = new URL('/runtime', baseURL);
  control.port = String(Number(control.port) + 1);
  expect((await request.post(control.href, { data: { reset: true } })).ok()).toBe(true);
});

test('rename shows parameter guidance, updates both titles and survives reload without adding a message', async ({
  page,
  request,
}) => {
  const id = await create(page);
  await saveConversationHistory(page);
  const prompts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(turns|steer)$/.test(request.url()))
      prompts.push(request.url());
  });
  await input(page).fill('/rename');
  await expect(page.getByRole('option', { name: /^\/rename / })).toContainText('/rename <名称>');
  await input(page).press('Enter');
  await expect(feedback(page)).toContainText('用法：/rename <名称>');
  await expect(input(page)).toHaveValue('/rename');
  await input(page).fill('/rename 发布前检查 🧪');
  await page.screenshot({ path: '/tmp/slash-rename-parameters.png', fullPage: true });
  await input(page).press('Enter');
  await expect(feedback(page)).toContainText('会话已重命名为「发布前检查 🧪」');
  await expect(page.locator('.topbar h1')).toHaveText('发布前检查 🧪');
  await expect(page.locator(`[data-thread-id="${id}"]`)).toContainText('发布前检查 🧪');
  await expect(input(page)).toHaveValue('');
  await page.screenshot({ path: '/tmp/slash-rename-success.png', fullPage: true });
  await page.reload();
  await expect(page.locator('.topbar h1')).toHaveText('发布前检查 🧪');
  const thread = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(thread.turns).toHaveLength(1);
  expect(thread.id).toBe(id);
  expect(prompts).toEqual([]);
});

test('validation and rejected or unknown receipts preserve the command draft and original title', async ({
  page,
}) => {
  const id = await create(page);
  for (const text of ['/rename ' + '名'.repeat(101), '/rename first\nsecond']) {
    await input(page).fill(text);
    await input(page).press('Enter');
    await expect(feedback(page)).toHaveAttribute('role', 'alert');
    await expect(input(page)).toHaveValue(text);
  }
  await page.route(`**/api/threads/${id}/rename`, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'RENAME_FAILED', message: '测试重命名被拒绝' } }),
    }),
  );
  await input(page).fill('/rename 失败后保留');
  await input(page).press('Enter');
  await expect(feedback(page)).toHaveAttribute('role', 'alert');
  await expect(input(page)).toHaveValue('/rename 失败后保留');
  await expect(page.locator('.topbar h1')).toHaveText('新会话');
  await page.unroute(`**/api/threads/${id}/rename`);
  let requests = 0;
  await page.route(`**/api/threads/${id}/rename`, (route) => {
    requests++;
    return route.abort('failed');
  });
  await input(page).fill('/rename 未确认不重试');
  await input(page).press('Enter');
  await expect(feedback(page)).toHaveAttribute('role', 'alert');
  await input(page).press('Enter');
  expect(requests).toBe(1);
  await expect(input(page)).toHaveValue('/rename 未确认不重试');
});

test('late rename receipt cannot replace a newly selected project draft', async ({
  page,
  request,
}) => {
  const id = await create(page);
  await saveConversationHistory(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(`**/api/threads/${id}/rename`, async (route) => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  await input(page).fill('/rename 原会话已改名');
  await input(page).press('Enter');
  await dispatched;
  await input(page).fill('原会话继续编辑的草稿');
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await input(page).fill('新项目独立草稿');
  release();
  await expect(input(page)).toHaveValue('新项目独立草稿');
  await expect(feedback(page)).toHaveCount(0);
  expect((await (await request.get(`/api/threads/${id}`)).json()).title).toBe('原会话已改名');
  await page.locator(`[data-thread-id="${id}"]`).click();
  await expect(input(page)).toHaveValue('原会话继续编辑的草稿');
  await expect(page.locator('.topbar h1')).toHaveText('原会话已改名');
});

test('renaming during a running turn does not interrupt it and wins over automatic title generation', async ({
  page,
  request,
  baseURL,
}) => {
  const id = await create(page);
  await input(page).fill('[approval] 保持任务等待审批以验证重命名');
  await input(page).press('Enter');
  await expect(page.locator('.action-card')).toBeVisible();
  const before = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  await input(page).fill('/rename 手工名称优先');
  await input(page).press('Enter');
  await expect(feedback(page)).toContainText('手工名称优先');
  await expect(page.locator('.action-card')).toBeVisible();
  const after = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(after.turns.map((turn) => [turn.id, turn.status])).toEqual(
    before.turns.map((turn) => [turn.id, turn.status]),
  );
  expect(after.title).toBe('手工名称优先');
  await request.post(`/api/threads/${id}/interrupt`, {
    headers: { Origin: baseURL! },
    data: { clientOperationId: randomUUID(), expectedTurnId: after.turns.at(-1)!.id },
  });
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已中断');
  await page.reload();
  await expect(page.locator('.topbar h1')).toHaveText('手工名称优先');
});
