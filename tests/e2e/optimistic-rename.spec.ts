import { expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, projectGroup } from './helpers';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const screenshot = (page: Page, name: string) =>
  page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
async function seed(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('名称更新验证 [title-fail]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}
async function rename(page: Page, name: string) {
  await page.getByRole('button', { name: '重命名会话', exact: true }).click();
  await page.getByRole('textbox', { name: '会话名称', exact: true }).fill(name);
  await page.getByRole('button', { name: '保存会话名称', exact: true }).click();
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('both title surfaces update before dispatch and success does not steal composer focus', async ({
  page,
}) => {
  const id = await seed(page);
  await screenshot(page, 'rename-before');
  const blocked = gate();
  await page.route(`**/api/threads/${id}/rename`, async (route) => {
    await blocked.promise;
    await route.continue();
  });
  await rename(page, '马上显示的新名称');
  await expect(page.locator('.topbar h1')).toHaveText('马上显示的新名称');
  await expect(page.locator(`[data-thread-id="${id}"] .thread-title`)).toHaveText(
    '马上显示的新名称',
  );
  await expect(page.locator('.mutation-notice')).toContainText('正在保存会话名称');
  await screenshot(page, 'rename-pending');
  const composer = page.getByRole('textbox', { name: '任务内容', exact: true });
  await composer.fill('保存期间继续编辑');
  blocked.release();
  await expect(page.locator('.mutation-notice')).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('保存期间继续编辑');
  await screenshot(page, 'rename-confirmed');
  await page.reload();
  await expect(page.locator('.topbar h1')).toHaveText('马上显示的新名称');
});

test('a definite failure restores the old name and retains the attempted name for correction', async ({
  page,
}) => {
  const id = await seed(page);
  const previous = await page.locator('.topbar h1').innerText();
  const blocked = gate();
  await page.route(`**/api/threads/${id}/rename`, async (route) => {
    await blocked.promise;
    await route.fulfill({
      status: 409,
      json: { error: { code: 'RENAME_FAILED', message: '服务器拒绝本次名称修改' } },
    });
  });
  await rename(page, '失败后继续编辑的名称');
  await expect(page.locator('.topbar h1')).toHaveText('失败后继续编辑的名称');
  blocked.release();
  await expect(page.locator('.topbar h1')).toHaveText(previous);
  await expect(page.getByRole('textbox', { name: '会话名称', exact: true })).toHaveValue(
    '失败后继续编辑的名称',
  );
  await expect(page.locator('.error-banner.dismissible')).toContainText('服务器拒绝');
  await screenshot(page, 'rename-rollback');
});

test('unknown rename persists through reload and cannot rename another selected project', async ({
  page,
}) => {
  const id = await seed(page);
  let writes = 0;
  await page.route(`**/api/threads/${id}/rename`, async (route) => {
    writes++;
    await route.abort('failed');
  });
  await rename(page, '结果待确认的新名称');
  await expect(page.locator('.mutation-notice')).toContainText('重命名结果待确认');
  await expect(page.locator('.topbar h1')).toHaveText('结果待确认的新名称');
  await screenshot(page, 'rename-unknown');
  await page.reload();
  await expect(page.locator('.topbar h1')).toHaveText('结果待确认的新名称');
  await expect(page.locator('.mutation-notice')).toContainText('重命名结果待确认');
  await projectGroup(page, '另一个项目').locator('.project-link').click();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('其他项目草稿');
  await page.locator('.mutation-notice').getByRole('button', { name: '核对提交' }).click();
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '其他项目草稿',
  );
  expect(writes).toBe(1);
});
