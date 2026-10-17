import { expect, test } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  expectThreadReady,
} from './helpers';

test('replaces the first prompt with an AI title in both tabs and retains it after more turns and reload', async ({
  page,
  request,
  context,
}, testInfo) => {
  await controlRuntime(request, { reset: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expectThreadReady(page);
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const title = page.locator(`[data-thread-id="${id}"] .thread-title`);
  await expect(title).toHaveCount(0);
  const firstPrompt = '解释一下运行设置如何继承 Codex 配置';
  const generatedTitle = 'Codex 配置继承与运行设置';
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator(`[data-thread-id="${id}"]`)).toHaveCount(0);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(firstPrompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(title).toHaveText(firstPrompt);
  await other.locator(`[data-thread-id="${id}"]`).click();
  await page.screenshot({ path: testInfo.outputPath('thread-title-before.png'), fullPage: true });
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(title).toHaveText(generatedTitle);
  await expect(page.locator('.topbar h1')).toHaveText(generatedTitle);
  await expect(other.locator('.topbar h1')).toHaveText(generatedTitle);
  await expect(other.locator(`[data-thread-id="${id}"] .thread-title`)).toHaveText(generatedTitle);
  await expect(page.locator('.turn')).toHaveCount(1);
  await other.close();
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('再说明一下模型和权限设置');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(title).toHaveText(generatedTitle);
  await page.reload();
  await expect(title).toHaveText(generatedTitle);
  await expect(page.locator('.topbar h1')).toHaveText(generatedTitle);
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

test('keeps the preview on failure and generates a title after the next user message', async ({
  page,
  request,
}, testInfo) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  const prompt = '命名失败时仍能继续对话 [title-fail]';
  await expectThreadReady(page);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.locator('.topbar h1')).toHaveText(prompt);
  await page.screenshot({
    path: testInfo.outputPath('thread-title-retry-before.png'),
    fullPage: true,
  });
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('继续回答');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.locator('.topbar h1')).toHaveText('Codex 配置继承与运行设置');
  await page.reload();
  await expect(page.locator('.topbar h1')).toHaveText('Codex 配置继承与运行设置');
  await expect(page.locator('.turn')).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath('thread-title-retry-after.png'),
    fullPage: true,
  });
});
