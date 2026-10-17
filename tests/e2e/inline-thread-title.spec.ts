import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  confirmCompatibility,
  createThreadButton,
  saveConversationHistory,
  expectThreadReady,
} from './helpers';
import type { ThreadView } from '../../src/shared/types';

const rename = (page: Page) => page.getByRole('button', { name: '重命名会话', exact: true });
const nameInput = (page: Page) => page.getByRole('textbox', { name: '会话名称', exact: true });
const save = (page: Page) => page.getByRole('button', { name: '保存会话名称', exact: true });
const cancel = (page: Page) => page.getByRole('button', { name: '取消重命名', exact: true });
const error = (page: Page) => page.locator('.thread-title-form').getByRole('alert');
const selected = (page: Page) =>
  page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
async function create(page: Page, withHistory = false) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expectThreadReady(page);
  const id = (await selected(page))!;
  if (withHistory) {
    await saveConversationHistory(page);
    const renamed = await page.request.post(`/api/threads/${id}/rename`, {
      headers: { Origin: new URL(page.url()).origin },
      data: { clientOperationId: randomUUID(), name: '新会话' },
    });
    expect(renamed.ok()).toBe(true);
    await expect(page.locator('.topbar h1')).toHaveText('新会话');
  }
  return id;
}
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.beforeEach(async ({ request, baseURL }) => {
  const control = new URL('/runtime', baseURL);
  control.port = String(Number(control.port) + 1);
  expect((await request.post(control.href, { data: { reset: true } })).ok()).toBe(true);
});

test('editing the heading updates both tabs and persists without adding a message', async ({
  page,
  context,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const id = await create(page, true);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('.topbar h1')).toHaveText('新会话');
  const prompts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(turns|steer)$/.test(request.url()))
      prompts.push(request.url());
  });
  await screenshot(page, testInfo, 'inline-title-desktop-before');
  await rename(page).click();
  await expect(nameInput(page)).toBeFocused();
  await expect(nameInput(page)).toHaveValue('新会话');
  await nameInput(page).fill('  发布前检查 🧪  ');
  await screenshot(page, testInfo, 'inline-title-desktop-editing');
  await nameInput(page).press('Enter');
  await expect(
    page.getByRole('heading', { level: 1, name: '发布前检查 🧪', exact: true }),
  ).toBeVisible();
  await expect(rename(page)).toBeFocused();
  for (const tab of [page, other]) {
    await expect(tab.locator('.topbar h1')).toHaveText('发布前检查 🧪');
    await expect(tab.locator(`[data-thread-id="${id}"] .thread-title`)).toHaveText('发布前检查 🧪');
  }
  await screenshot(page, testInfo, 'inline-title-desktop-saved');
  await page.reload();
  await expect(page.locator('.topbar h1')).toHaveText('发布前检查 🧪');
  const thread = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(thread.id).toBe(id);
  expect(thread.turns).toHaveLength(1);
  expect(prompts).toEqual([]);
  await other.close();
});

test('cancel, blur, IME, validation and a rejected save preserve the intended draft', async ({
  page,
}, testInfo) => {
  const id = await create(page);
  let requests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`/threads/${id}/rename`)) requests++;
  });
  await rename(page).click();
  await nameInput(page).fill('尚未保存');
  await page.getByRole('textbox', { name: '任务内容', exact: true }).click();
  await expect(nameInput(page)).toHaveValue('尚未保存');
  await nameInput(page).press('Escape');
  await expect(rename(page)).toBeFocused();
  await expect(page.locator('.topbar h1')).toHaveText('新会话');
  await rename(page).press('Enter');
  await nameInput(page).fill('中文候选词');
  await nameInput(page).dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    isComposing: true,
  });
  await nameInput(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await nameInput(page).dispatchEvent('compositionstart');
  await nameInput(page).dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    isComposing: false,
  });
  await nameInput(page).evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '词' }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  });
  await expect(nameInput(page)).toHaveValue('中文候选词');
  expect(requests).toBe(0);
  await nameInput(page).fill('   ');
  await save(page).click();
  await expect(error(page)).toHaveText('请输入会话名称。');
  await nameInput(page).fill('🧪'.repeat(101));
  await nameInput(page).press('Enter');
  await expect(error(page)).toHaveText('会话名称最多 100 个字符。');
  expect(requests).toBe(0);

  await page.route(`**/api/threads/${id}/rename`, (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'RENAME_FAILED', message: '测试重命名被拒绝' } },
    }),
  );
  await nameInput(page).fill('发布前检查：保留重试草稿');
  await save(page).click();
  await expect(error(page)).toContainText('未收到可确认的成功回执');
  await expect(nameInput(page)).toHaveValue('发布前检查：保留重试草稿');
  await expect(nameInput(page)).toBeFocused();
  await expect(page.locator('.topbar h1')).toHaveText('新会话');
  await screenshot(page, testInfo, 'inline-title-desktop-error');
  await page.unroute(`**/api/threads/${id}/rename`);
  await nameInput(page).fill('🧪'.repeat(100));
  await nameInput(page).press('Enter');
  await expect(page.locator('.topbar h1')).toHaveText('🧪'.repeat(100));
  expect(requests).toBe(2);
});

test('live title updates preserve a draft and delayed receipts cannot retarget another editor', async ({
  page,
  request,
  baseURL,
}) => {
  const source = await create(page, true);
  await rename(page).click();
  await nameInput(page).fill('本地未保存草稿');
  const updated = await request.post(`/api/threads/${source}/rename`, {
    headers: { Origin: baseURL! },
    data: { clientOperationId: randomUUID(), name: '另一标签更新的名称' },
  });
  expect(updated.ok()).toBe(true);
  await expect(page.locator(`[data-thread-id="${source}"] .thread-title`)).toHaveText(
    '另一标签更新的名称',
  );
  await expect(nameInput(page)).toHaveValue('本地未保存草稿');
  await cancel(page).click();
  await expect(page.locator('.topbar h1')).toHaveText('另一标签更新的名称');
  await createThreadButton(page).click();
  await expect(page.locator('.topbar h1')).toHaveText('新会话');
  const other = (await selected(page))!;
  await saveConversationHistory(page);
  await page.locator(`[data-thread-id="${source}"]`).click();
  await rename(page).click();
  await expect(nameInput(page)).toHaveValue('另一标签更新的名称');
  await nameInput(page).fill('迟到回执只属于原会话');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let requests = 0;
  await page.route(`**/api/threads/${source}/rename`, async (route) => {
    requests++;
    arrived();
    await gate;
    await route.continue();
  });
  try {
    await nameInput(page).press('Enter');
    await dispatched;
    await expect(nameInput(page)).toBeDisabled();
    await expect(save(page)).toBeDisabled();
    await expect(cancel(page)).toBeDisabled();
    await nameInput(page).dispatchEvent('keydown', { key: 'Enter', bubbles: true });
    await page.locator(`[data-thread-id="${other}"]`).click();
    await rename(page).click();
    await nameInput(page).fill('新会话独立草稿');
    release();
    await expect(page.locator(`[data-thread-id="${source}"] .thread-title`)).toHaveText(
      '迟到回执只属于原会话',
    );
    await expect(nameInput(page)).toHaveValue('新会话独立草稿');
    expect(await selected(page)).toBe(other);
    expect(requests).toBe(1);
    await page.locator(`[data-thread-id="${source}"]`).click();
    await expect(nameInput(page)).toHaveCount(0);
    await expect(page.locator('.topbar h1')).toHaveText('迟到回执只属于原会话');
  } finally {
    release();
  }
});

test('mobile title editing keeps save and cancel visible without horizontal overflow', async ({
  page,
}, testInfo) => {
  await create(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar')).not.toBeInViewport();
  await rename(page).click();
  await nameInput(page).fill('移动端会话名称：发布前检查 🧪');
  await expect(nameInput(page)).toBeInViewport();
  await expect(save(page)).toBeInViewport();
  await expect(cancel(page)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await screenshot(page, testInfo, 'inline-title-mobile-editing');
  await save(page).click();
  await expect(page.locator('.topbar h1')).toHaveText('移动端会话名称：发布前检查 🧪');
  await screenshot(page, testInfo, 'inline-title-mobile-saved');
  await rename(page).click();
  await nameInput(page).fill('放弃移动端修改');
  await cancel(page).click();
  await expect(page.locator('.topbar h1')).toHaveText('移动端会话名称：发布前检查 🧪');
});
