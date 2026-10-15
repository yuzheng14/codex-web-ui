import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createThreadButton, projectGroup } from './helpers';

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('shows inherited settings, separates pending changes and follows confirmed settings after reload', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await page.locator('.settings-panel > summary').click();
  const current = page.locator('.settings-current');
  await expect(current).toContainText('新会话默认配置：simulated-model · 推理强度 medium');
  await createThreadButton(page).click();
  await expect(current).toContainText('会话当前配置：simulated-model · 推理强度 medium');
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  await expect(effort).toBeEnabled();
  await expect(effort.locator('option:checked')).toHaveText('继承（medium）');
  await effort.selectOption('high');
  await expect(page.locator('.settings-pending')).toContainText('下次使用：simulated-model · high');
  await expect(page.locator('.settings-panel > summary')).toContainText('simulated-model · medium');
  await page.locator('.settings-panel').screenshot({ path: '/tmp/codex-settings-pending.png' });
  await page.getByRole('textbox', { name: '任务内容' }).fill('确认推理强度设置');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(current).toContainText('会话当前配置：simulated-model · 推理强度 high');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await effort.selectOption('');
  await expect(effort.locator('option:checked')).toHaveText('继承（high）');
  await page.reload();
  await expect(page.locator('.settings-panel > summary')).toContainText('simulated-model · high');
  await page.locator('.settings-panel > summary').click();
  await expect(effort.locator('option:checked')).toHaveText('继承（high）');
  await page.locator('.settings-panel').screenshot({ path: '/tmp/codex-settings-after.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
  await page.getByRole('button', { name: '关闭导航', exact: true }).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: '/tmp/codex-settings-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('keeps project defaults isolated when a previous project responds late', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects/fixture/model-settings', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await page.locator('.settings-panel > summary').click();
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await expect(page.locator('.settings-current')).toContainText('推理强度 high');
  const oldResponse = page.waitForResponse('**/api/projects/fixture/model-settings');
  release();
  await oldResponse;
  await expect(page.locator('.settings-current')).toContainText('推理强度 high');
});

test('shows read failures and unknown values without inventing defaults, and retries', async ({
  page,
}) => {
  let failed = true;
  await page.route('**/model-settings', async (route) => {
    if (failed)
      await route.fulfill({
        status: 503,
        json: { error: { code: 'CODEX_UNAVAILABLE', message: 'unavailable' } },
      });
    else await route.fulfill({ json: { model: 'private-custom-model', reasoningEffort: null } });
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await page.locator('.settings-panel > summary').click();
  await expect(page.locator('.settings-current')).toContainText('无法读取默认配置');
  failed = false;
  await page.locator('.settings-current').getByRole('button', { name: '重试' }).click();
  await expect(page.locator('.settings-current')).toContainText(
    'private-custom-model · 推理强度 未报告',
  );
  await expect(page.getByRole('combobox', { name: '推理强度', exact: true })).toBeDisabled();
});
