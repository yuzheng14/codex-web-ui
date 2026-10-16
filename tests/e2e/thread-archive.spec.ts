import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

const selectedId = (page: Page) =>
  page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
const row = (page: Page, id: string) =>
  page.locator('.thread-row').filter({ has: page.locator(`[data-thread-id="${id}"]`) });
async function archive(page: Page, id: string, restore = false) {
  await row(page, id)
    .getByRole('button', { name: restore ? '取消归档' : '归档会话', exact: true })
    .click();
}
async function create(page: Page, text: string) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  const id = (await selectedId(page))!;
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  return id;
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('archives the selected conversation, reloads its history, restores the same identity and continues', async ({
  page,
  request,
}) => {
  const id = await create(page, '请保存这段会话历史，稍后继续。');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await expect(row(page, id)).toContainText('Codex 配置继承与运行设置');
  await page.getByRole('textbox', { name: '任务内容' }).fill('取消归档后保留的草稿');
  const action = row(page, id).getByRole('button', { name: '归档会话', exact: true });
  await action.hover();
  await expect(row(page, id).getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(page, id).getByRole('tooltip')).toBeHidden();
  await action.focus();
  await expect(row(page, id).getByRole('tooltip')).toHaveText('归档会话');
  await page.screenshot({
    path: test.info().outputPath('archive-icon.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await row(page, id).getByRole('button', { name: '归档会话', exact: true }).click();
  await expect(page.locator('.archive-notice')).toContainText('此会话已归档');
  await expect(page.getByRole('button', { name: '已归档会话', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(row(page, id).locator('.thread-link')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  expect((await (await request.get('/api/projects/fixture/threads')).json()).data).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath('archived.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('.archive-notice').getByRole('button', { name: '取消归档' }).click();
  await expect(page.getByRole('textbox', { name: '任务内容' })).toHaveValue('取消归档后保留的草稿');
  await archive(page, id);
  await page.reload();
  await expect(page.locator('.archive-notice')).toBeVisible();
  expect(await selectedId(page)).toBe(id);
  await expect(page.locator('.conversation-content')).toContainText(
    '请保存这段会话历史，稍后继续。',
  );
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(row(page, id)).toHaveCount(0);
  await page.getByRole('button', { name: '已归档会话', exact: true }).click();
  await row(page, id).locator('.thread-link').click();
  await page.locator('.archive-notice').getByRole('button', { name: '取消归档' }).click();
  await expect(page.getByRole('button', { name: '会话', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('textbox', { name: '任务内容' }).fill('继续原来的对话');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  const thread = await (await request.get(`/api/threads/${id}`)).json();
  expect(thread.archived).toBe(false);
  expect(thread.turns).toHaveLength(2);
  expect(await selectedId(page)).toBe(id);
  await page.screenshot({
    path: test.info().outputPath('restored.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('disables archive for running approvals and synchronizes completed archive changes across tabs', async ({
  page,
  context,
}) => {
  const id = await create(page, '[approval] 等待批准后才能归档');
  await expect(page.locator('.action-card')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('.action-card')).toBeVisible();
  const action = row(page, id).getByRole('button', { name: '归档会话', exact: true });
  await expect(action).toBeDisabled();
  await action.focus();
  await expect(row(page, id).getByRole('tooltip')).toHaveText('任务结束并处理完待办后可归档');
  await page.screenshot({
    path: test.info().outputPath('archive-active.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(row(page, id).getByRole('tooltip')).toBeHidden();
  await page.locator('.action-card').getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(other.locator('.turn-heading .status')).toHaveText('已完成');
  await archive(page, id);
  for (const tab of [page, other]) await expect(tab.locator('.archive-notice')).toBeVisible();
  await other.locator('.archive-notice').getByRole('button', { name: '取消归档' }).click();
  await expect(page.locator('.archive-notice')).toHaveCount(0);
  await page.getByRole('textbox', { name: '任务内容' }).fill('恢复后继续');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

test('failed archive and restore writes keep the saved state and show an actionable error', async ({
  page,
}) => {
  const id = await create(page, '归档失败时保留历史');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const path = `**/api/threads/${id}/archive`;
  const reject = () =>
    page.route(path, (route) =>
      route.fulfill({
        status: 400,
        json: { error: { code: 'CODEX_REQUEST_FAILED', message: 'Codex 无法归档此会话，请重试' } },
      }),
    );
  await reject();
  await archive(page, id);
  await expect(page.locator('.error-banner.dismissible')).toContainText('Codex 无法归档此会话');
  await expect(row(page, id)).toBeVisible();
  await expect(page.locator('.archive-notice')).toHaveCount(0);
  await page.unroute(path);
  await archive(page, id);
  await expect(page.locator('.archive-notice')).toBeVisible();
  await reject();
  await page.locator('.archive-notice').getByRole('button', { name: '取消归档' }).click();
  await expect(page.locator('.error-banner.dismissible')).toContainText('Codex 无法归档此会话');
  await expect(page.locator('.archive-notice')).toBeVisible();
  await expect(row(page, id)).toBeVisible();
});

test('recovers a committed archive after losing its HTTP receipt, without resending', async ({
  page,
}) => {
  const id = await create(page, '丢失回执时核对保存状态');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  let writes = 0;
  await page.route(`**/api/threads/${id}/archive`, async (route) => {
    writes++;
    await route.fetch();
    await route.abort('failed');
  });
  await archive(page, id);
  await expect(page.locator('.archive-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: '已归档会话', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await expect(page.locator('.archive-notice')).toBeVisible();
  expect(writes).toBe(1);
});

test('archived unmanaged history is viewable on mobile without automatically resuming it', async ({
  page,
  request,
}) => {
  const { externalThreadId: id } = await controlRuntime(request, { external: 'free' });
  await page.goto('/');
  await confirmCompatibility(page);
  const result = await request.post(`/api/threads/${id}/archive`, {
    headers: { Origin: 'http://127.0.0.1:8788' },
    data: { archived: true, clientOperationId: randomUUID() },
  });
  expect(result.ok()).toBe(true);
  let resumes = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/resume')) resumes++;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await page.getByRole('button', { name: '已归档会话', exact: true }).click();
  await row(page, id!).locator('.thread-link').click();
  await expect(page.locator('.archive-notice')).toBeVisible();
  await expect(page.locator('.conversation-content')).toContainText('已保存的会话历史');
  await expect(page.getByText('正在恢复会话…', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('archived-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(resumes).toBe(0);
});
