import { expect, test, type Locator, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

const reply = (page: Page) => page.getByRole('article', { name: 'Codex 的回复' });
const turnStatus = (page: Page) => page.locator('.turn-heading .status');
async function start(page: Page, prompt = '[markdown] 请把命令优先级整理成表格') {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}
async function expectTable(table: Locator) {
  await expect(table.getByRole('columnheader')).toHaveText(['优先级', '命令', '为什么值得做']);
  await expect(table.getByRole('row')).toHaveCount(6);
  await expect(
    table.getByRole('cell', { name: '/rename', exact: true }).locator('code'),
  ).toHaveText('/rename');
  await expect(table.getByRole('cell', { name: 'a|b', exact: true }).locator('code')).toHaveText(
    'a|b',
  );
  await expect(table.getByRole('cell', { name: /支持转义管道/ })).toContainText('A|B');
  await expect(table.locator('strong')).toContainText(['第一批', '第一批', '第一批', '重点']);
  for (const [index, alignment] of ['left', 'center', 'right'].entries()) {
    await expect(table.getByRole('columnheader').nth(index)).toHaveCSS('text-align', alignment);
    await expect(table.locator('tbody tr').first().getByRole('cell').nth(index)).toHaveCSS(
      'text-align',
      alignment,
    );
  }
}

test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
});

test('GFM tables render during streaming and preserve cells, formatting and alignment after reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  const table = reply(page).getByRole('table');
  // The fixture splits the delimiter row across deltas and leaves the turn open.
  await expect(table.getByRole('cell', { name: '/rename', exact: true })).toBeVisible();
  await expect(turnStatus(page)).toHaveText('执行中');
  const region = reply(page).getByRole('region', { name: '表格', exact: true });
  const element = await region.elementHandle();
  await region.focus();
  const scrollLeft = await region.evaluate((node) => {
    node.scrollLeft = 40;
    return node.scrollLeft;
  });
  expect(scrollLeft).toBeGreaterThan(0);
  // Later deltas must update the existing table rather than remounting its scroller.
  await expect(table.getByRole('row')).toHaveCount(6);
  expect(await region.evaluate((node, previous) => node === previous, element)).toBe(true);
  await expect(region).toBeFocused();
  expect(await region.evaluate((node) => node.scrollLeft)).toBe(scrollLeft);
  await expect(turnStatus(page)).toHaveText('已完成');
  await expectTable(table);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.reload();
  await expect(turnStatus(page)).toHaveText('已完成');
  await expectTable(reply(page).getByRole('table'));
  await reply(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/tmp/codex-markdown-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
});

// Each viewport gets a fresh page so an in-flight native keyboard scroll cannot
// be interrupted by resetting scrollLeft and resizing for the next assertion.
for (const width of [320, 390]) {
  test(`${width}px tables scroll locally with the keyboard without widening the page`, async ({
    page,
  }) => {
    await start(page);
    await expect(turnStatus(page)).toHaveText('已完成');
    const region = reply(page).getByRole('region', { name: '表格', exact: true });
    await page.setViewportSize({ width, height: 844 });
    await region.scrollIntoViewIfNeeded();
    await expect(region).toHaveAttribute('tabindex', '0');
    await expect(region).toHaveCSS('overflow-x', 'auto');
    expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await page
        .locator('.conversation-scroll')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    if (width === 390) {
      await page.screenshot({
        path: '/tmp/codex-markdown-mobile.png',
        fullPage: true,
        animations: 'disabled',
      });
    }
    await region.focus();
    await expect(region).toBeFocused();
    expect(await region.evaluate((element) => element.scrollLeft)).toBe(0);
    await region.press('ArrowRight');
    await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  });
}

test('GFM keeps task lists, strikethrough and code fences while retaining HTML and URL safety', async ({
  page,
}) => {
  await start(page, '[markdown-security] 检查 Markdown 兼容性');
  await expect(turnStatus(page)).toHaveText('已完成');
  const content = reply(page);
  await expect(content.locator('del')).toHaveText('已替换的方案');
  const checkboxes = content.getByRole('checkbox');
  await expect(checkboxes).toHaveCount(2);
  await expect(checkboxes.nth(0)).toBeChecked();
  await expect(checkboxes.nth(1)).not.toBeChecked();
  await expect(checkboxes.nth(0)).toBeDisabled();
  await expect(checkboxes.nth(1)).toBeDisabled();
  await expect(content.locator('pre code')).toContainText('| 这不是 | 表格 |');
  await expect(content.getByRole('table')).toHaveCount(0);
  const link = content.getByRole('link', { name: '正常链接', exact: true });
  await expect(link).toHaveAttribute('href', 'https://example.com/docs');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(content.locator('a').filter({ hasText: '危险链接' })).toHaveAttribute('href', '');
  await expect(content.locator('script, img')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'markdownInjected'))).toBeUndefined();
});
