import { expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  expectThreadReady,
} from './helpers';

const input = (page: Page) => page.getByRole('textbox', { name: '任务内容', exact: true });
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });
const rows = (page: Page, id: string) => page.locator(`[data-thread-id="${id}"]`);
const selected = (page: Page) =>
  page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
async function newThread(page: Page) {
  await createThreadButton(page).click();
  await expectThreadReady(page);
}

test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
});

test('new drafts stay editable, stay out of both tabs and disappear after reload', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const welcome = page.getByRole('heading', { name: '从一个想法，开始工作。', exact: true });
  await expect(welcome).toBeVisible();
  await expect(page.getByTestId('workspace-start')).toHaveAttribute('data-thread-ready', 'false');
  await newThread(page);
  await expect(welcome).toBeVisible();
  await expect(page.locator('.thread-actions')).toHaveCount(0);
  await expect(page.getByText('描述你要完成的任务，也可以粘贴图片、问题或错误信息。')).toBeVisible();
  const id = (await selected(page))!;
  expect(id).toBeTruthy();
  await expect(rows(page, id)).toHaveCount(0);
  await expect(input(page)).toBeEnabled();
  const other = await context.newPage();
  await other.goto('/');
  await expect(rows(other, id)).toHaveCount(0);
  await expect(other.getByTestId('workspace-start')).toHaveAttribute('data-thread-ready', 'false');
  await other.close();
  await page.screenshot({ path: testInfo.outputPath('draft-before-send.png'), fullPage: true });
  // Simulate a legacy saved selection as well as the current browser's preference.
  await page.evaluate((id) => localStorage.setItem('codex-web.selected:fixture', id!), id);
  let resumed = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/resume')) resumed++;
  });
  await page.reload();
  await expect(rows(page, id)).toHaveCount(0);
  await expect(welcome).toBeVisible();
  await expect(page.getByTestId('workspace-start')).toHaveAttribute('data-thread-ready', 'false');
  await expect.poll(() => selected(page)).toBeNull();
  expect(resumed).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath('empty-after-reload-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await expect(rows(page, id)).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('empty-after-reload-mobile.png'),
    fullPage: true,
  });
});

test('the first accepted message enters history and stays usable after reload', async ({
  page,
  context,
}, testInfo) => {
  await newThread(page);
  await expect(input(page)).toBeEnabled();
  const id = (await selected(page))!;
  const other = await context.newPage();
  await other.goto('/');
  await expect.poll(() => selected(other)).toBeNull();
  await input(page).fill('保存第一条消息');
  await send(page).click();
  await expect(rows(page, id)).toHaveCount(1);
  await expect(other.locator(`[data-thread-id="${id}"]`)).toBeVisible();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await other.close();
  await page.reload();
  await expect(page.locator('.user-text')).toHaveText('保存第一条消息');
  await expect.poll(() => selected(page)).toBe(id);
  await input(page).fill('刷新后继续对话');
  await send(page).click();
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await page.screenshot({ path: testInfo.outputPath('started-after-reload.png'), fullPage: true });
});

test('a legacy saved ID that Codex no longer knows is discarded without a resume or error', async ({
  page,
}) => {
  const id = await page.evaluate(() => {
    const id = crypto.randomUUID();
    localStorage.setItem('codex-web.selected:fixture', id);
    return id;
  });
  let resumed = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/resume')) resumed++;
  });
  await page.reload();
  await expect.poll(() => selected(page)).toBeNull();
  await expect(rows(page, id)).toHaveCount(0);
  await expect(page.locator('.error-banner.dismissible')).not.toBeVisible();
  expect(resumed).toBe(0);
});

test('a definite first-message rejection stays retryable and leaves no history after reload', async ({
  page,
}) => {
  await newThread(page);
  const id = (await selected(page))!;
  await input(page).fill('[reject-start] 没有被接受的消息');
  await send(page).click();
  await expect(page.locator('.error-banner.dismissible')).toContainText('模拟首条消息被拒绝');
  await expect(rows(page, id)).toHaveCount(0);
  await expect(input(page)).toHaveValue('[reject-start] 没有被接受的消息');
  await expect(send(page)).toBeEnabled();
  await page.reload();
  await expect.poll(() => selected(page)).toBeNull();
  await expect(rows(page, id)).toHaveCount(0);
});

test('refreshing a dispatched first message preserves it before turn creation or acknowledgement', async ({
  page,
}) => {
  await newThread(page);
  const id = (await selected(page))!;
  await input(page).fill('[delay-start] 发送中刷新');
  await send(page).click();
  await expect(rows(page, id)).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.user-text')).toHaveText('[delay-start] 发送中刷新');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect.poll(() => selected(page)).toBe(id);
  await expect(page.locator('.turn')).toHaveCount(1);
  await expect(rows(page, id)).toHaveCount(1);
});
