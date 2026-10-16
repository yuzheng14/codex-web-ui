import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

const evidence = join(tmpdir(), 'codex-issue-56-evidence');
const completion = (page: Page) => page.getByRole('group', { name: '本轮完成信息' });
const send = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
};
test.use({ timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1100 } });

test('completed turn TPS survives refresh, reconnect and navigation, with accessible explanation and mobile layout', async ({
  page,
  request,
  context,
}) => {
  await mkdir(evidence, { recursive: true });
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  await send(page, '[turn-tps:multi] 验证多次模型响应的平均 TPS');
  await expect(completion(page)).toContainText('耗时 20 秒 · 平均 60.0 TPS');
  const threadId = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  await send(page, '[turn-tps:next] 继续完成第二轮任务');
  await expect(completion(page).last()).toContainText('平均 15.0 TPS');
  const data = await (await request.get(`/api/threads/${threadId}`)).json();
  expect(data.turns.map((turn: { outputTokens?: number }) => turn.outputTokens)).toEqual([
    1200, 300,
  ]);
  await completion(page).last().locator('.turn-tps').focus();
  await expect(page.getByRole('tooltip')).toContainText('本轮输出 300 tokens');
  await expect(page.getByRole('tooltip')).toContainText('包含推理 token、工具执行和等待时间');
  await page.screenshot({ path: join(evidence, 'tps-desktop.png'), fullPage: true });
  await page.keyboard.press('Escape');
  const original = await completion(page).allTextContents();
  await page.reload();
  await expect(completion(page)).toHaveText(original);
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await context.setOffline(false);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(completion(page)).toHaveText(original);
  await createThreadButton(page).click();
  await page.locator(`[data-thread-id="${threadId}"]`).click();
  await expect(completion(page)).toHaveText(original);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(completion(page)).toHaveText(original);
  await completion(page).last().scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(evidence, 'tps-mobile.png'), fullPage: true });
  await send(page, '[turn-tps:missing] 兼容没有 token 统计的会话');
  await expect(completion(page).last()).toContainText('TPS 未知');
  await page.screenshot({ path: join(evidence, 'tps-unavailable.png'), fullPage: true });
});
