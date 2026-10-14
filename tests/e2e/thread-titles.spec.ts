import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

test('shows the upstream preview after the first prompt and retains it after more turns and reload', async ({
  page,
  request,
}, testInfo) => {
  await controlRuntime(request, { reset: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const title = page.locator(`[data-thread-id="${id}"] .thread-title`);
  await expect(title).toHaveText('新会话');
  const firstPrompt = '解释一下运行设置如何继承 Codex 配置';
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(firstPrompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(title).toHaveText(firstPrompt);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.locator('.topbar h1')).toHaveText(firstPrompt);
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('再说明一下模型和权限设置');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(title).toHaveText(firstPrompt);
  await page.reload();
  await expect(title).toHaveText(firstPrompt);
  await expect(page.locator('.topbar h1')).toHaveText(firstPrompt);
  await expect(page.locator('.turn')).toHaveCount(2);
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    if (name === 'mobile') await page.getByRole('button', { name: '打开项目与会话' }).click();
    const path = testInfo.outputPath(`thread-title-${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await testInfo.attach(`thread-title-${name}`, { path, contentType: 'image/png' });
  }
});
