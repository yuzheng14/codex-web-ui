import { expect, test, type Page } from '@playwright/test';
import type { ThreadView } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime } from './helpers';

const completion = (page: Page) => page.getByRole('group', { name: '本轮完成信息' });
const copyButton = (page: Page) => page.getByRole('button', { name: '复制回答', exact: true });
const send = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
};
async function savedThread(page: Page) {
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const response = await page.request.get(`/api/threads/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ThreadView;
}

test.use({ timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1100 } });
test.beforeEach(async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
});

test('copies exact reply Markdown and code, retains keyboard access after reload and works offline', async ({
  page,
  context,
}) => {
  await send(page, '[code-copy] 给出可复制的命令和 Markdown 示例');
  await expect(page.locator('.turn-heading .status')).toHaveText('执行中');
  await expect(copyButton(page)).toHaveCount(0);
  await expect(completion(page)).toHaveCount(1);
  const reply = (await savedThread(page)).turns[0]!.items.find(
    (item) => item.type === 'agentMessage',
  )!.text!;
  expect(reply).toContain('```bash\npnpm build\n  pnpm test');
  await page.reload();
  await copyButton(page).focus();
  await expect(copyButton(page)).toBeFocused();
  await copyButton(page).press('Enter');
  await expect(completion(page).getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(reply);
  await expect(completion(page).getByRole('status')).toBeEmpty();
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await copyButton(page).press('Space');
  await expect(completion(page).getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(reply);
});

test('copies only the selected turn’s last reply, with independent feedback and narrow-screen layout', async ({
  page,
}) => {
  await send(page, '[activity-collapse] 检查项目并给出结论');
  await expect(completion(page)).toHaveCount(1);
  const first = (await savedThread(page)).turns[0]!;
  const replies = first.items.filter((item) => item.type === 'agentMessage');
  expect(replies.length).toBeGreaterThan(1);
  const finalReply = replies.at(-1)!.text!;
  await send(page, '[markdown] 列出后续建议');
  await expect(completion(page)).toHaveCount(2);
  await completion(page).first().getByRole('button', { name: '复制回答', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(finalReply);
  await expect(completion(page).first().getByRole('status')).toHaveText('已复制');
  await expect(completion(page).last().getByRole('status')).toBeEmpty();
  await completion(page).last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/codex-reply-copy-desktop.png', animations: 'disabled' });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await completion(page).last().scrollIntoViewIfNeeded();
    const button = copyButton(page).last();
    await expect(button).toBeInViewport();
    await button.click();
    await expect(completion(page).last().getByRole('status')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      (await savedThread(page)).turns[1]!.items.findLast((item) => item.type === 'agentMessage')!
        .text,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 390)
      await page.screenshot({ path: '/tmp/codex-reply-copy-mobile.png', animations: 'disabled' });
  }
});

test('a completed compaction without a reply has no copy button', async ({ page }) => {
  await send(page, '检查项目并给出结论');
  await expect(completion(page)).toHaveCount(1);
  const input = page.getByRole('textbox', { name: '任务内容', exact: true });
  await input.fill('/compact');
  await input.press('Enter');
  await expect(completion(page)).toHaveCount(2);
  await expect(completion(page).last().getByRole('button', { name: '复制回答' })).toHaveCount(0);
  await expect(copyButton(page)).toHaveCount(1);
});

for (const failure of ['denied', 'unavailable']) {
  test(`clipboard ${failure}: shows failure without false success and allows retry`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await send(page, '完成检查并给出结论');
    await expect(completion(page)).toHaveCount(1);
    await page.evaluate((mode) => {
      const clipboard = navigator.clipboard;
      Reflect.set(window, 'restoreClipboard', () =>
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard }),
      );
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value:
          mode === 'unavailable'
            ? undefined
            : { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) },
      });
    }, failure);
    await copyButton(page).click();
    await expect(completion(page).getByRole('status')).toHaveText('复制失败，请手动选择回答复制。');
    await expect(page.getByText('已复制', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (failure === 'denied')
      await page.screenshot({ path: '/tmp/codex-reply-copy-failed.png', animations: 'disabled' });
    await page.evaluate(() => Reflect.get(window, 'restoreClipboard')());
    await copyButton(page).click();
    await expect(completion(page).getByRole('status')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('模拟任务已完成。');
  });
}
