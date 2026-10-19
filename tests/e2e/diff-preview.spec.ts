import { expect, test, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';

const preview = (page: Page) => page.getByRole('dialog', { name: '代码变更预览', exact: true });
const trigger = (page: Page) =>
  page.getByRole('button', { name: '本轮变更预览 查看文件与代码行变更', exact: true });
async function send(page: Page, scenario = '[diff-preview]') {
  const turns = await page.locator('.turn').count();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(scenario);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn')).toHaveCount(turns + 1);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
}
async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), `covro-diff-${name}.png`), animations: 'disabled' });
}
test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
});

test('desktop uses a shared side panel, structured multi-file diffs and independent navigation', async ({
  page,
}) => {
  await send(page);
  await trigger(page).click();
  await expect(preview(page).locator('.diff-table')).toBeVisible();
  await expect(preview(page).getByLabel('变更文件')).toHaveValue('0');
  await expect(preview(page).locator('.diff-file-heading')).toContainText('src/预览 workspace.ts');
  await expect(preview(page).locator('.diff-added').first()).toContainText('const layout = "web"');
  await expect(preview(page).locator('.diff-removed').first()).toContainText(
    'const layout = "terminal"',
  );
  await expect(preview(page).locator('.diff-line-number').first()).toHaveText('1');
  const panel = (await preview(page).boundingBox())!,
    main = (await page.locator('.main-panel').boundingBox())!;
  expect(main.x + main.width).toBeLessThanOrEqual(panel.x + 1);
  expect(await preview(page).evaluate((element) => element.matches(':modal'))).toBe(false);
  const chatScroll = await page
    .locator('.conversation-scroll')
    .evaluate((element) => element.scrollTop);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('保留讨论草稿');
  await screenshot(page, 'desktop');
  await preview(page).getByRole('button', { name: '下一个变更区块' }).click();
  expect(
    await preview(page)
      .getByLabel('变更内容', { exact: true })
      .evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
  await preview(page)
    .getByLabel('变更内容', { exact: true })
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.scrollLeft = 200;
    });
  expect(
    await preview(page)
      .getByLabel('变更内容', { exact: true })
      .evaluate((element) => element.scrollLeft),
  ).toBeGreaterThan(0);
  await preview(page).getByRole('button', { name: '自动换行' }).click();
  await expect(preview(page).getByRole('button', { name: '自动换行' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(
    await preview(page)
      .getByLabel('变更内容', { exact: true })
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await preview(page).getByLabel('变更文件').selectOption('1');
  await expect(preview(page).locator('.diff-kind')).toHaveText('新增');
  await expect(preview(page).locator('.diff-stats')).toHaveText('+2−0');
  expect(
    await preview(page)
      .getByLabel('变更内容', { exact: true })
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
  await preview(page).getByLabel('变更文件').selectOption('2');
  await expect(preview(page).locator('.diff-kind')).toHaveText('删除');
  await expect(preview(page).locator('.diff-stats')).toHaveText('+0−1');
  await preview(page).getByLabel('变更文件').selectOption('3');
  await expect(preview(page).getByText('二进制文件已变更')).toBeVisible();
  await screenshot(page, 'binary');
  await preview(page).getByLabel('变更文件').selectOption('4');
  await expect(preview(page).locator('.diff-kind')).toHaveText('重命名');
  await expect(preview(page).locator('.diff-rename')).toContainText('docs/guide.md');
  await page.keyboard.press('Escape');
  await expect(preview(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(await page.locator('.conversation-scroll').evaluate((element) => element.scrollTop)).toBe(
    chatScroll,
  );
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '保留讨论草稿',
  );
});

for (const width of [390, 320]) {
  test(`${width}px: full-screen reader keeps controls visible and returns to the conversation`, async ({
    page,
  }) => {
    await send(page);
    await page.setViewportSize({ width, height: 844 });
    await trigger(page).click();
    await expect(preview(page).locator('.diff-table')).toBeVisible();
    expect(await preview(page).evaluate((element) => element.matches(':modal'))).toBe(true);
    expect((await preview(page).boundingBox())!.width).toBe(width);
    await preview(page).getByRole('button', { name: '自动换行' }).click();
    await screenshot(page, `mobile-${width}`);
    await preview(page).getByRole('button', { name: '下一个变更区块' }).click();
    await expect(preview(page).getByRole('button', { name: '关闭代码变更预览' })).toBeInViewport();
    await expect(preview(page).getByLabel('变更文件')).toBeInViewport();
    await preview(page).getByLabel('变更文件').selectOption('1');
    await expect(preview(page).locator('.diff-kind')).toHaveText('新增');
    await preview(page).getByRole('button', { name: '关闭代码变更预览' }).click();
    await expect(trigger(page)).toBeFocused();
  });
}

test('tool entry selects its file; thread changes and responsive mode release the preview', async ({
  page,
}) => {
  await send(page);
  await page.locator('details.activity-group > summary').click();
  await page.locator('details.activity > summary').click();
  await page.getByRole('button', { name: /docs\/新功能.md.*查看变更/ }).click();
  await expect(preview(page).getByLabel('变更文件')).toHaveValue('1');
  await expect(preview(page)).toContainText('此工具的文件变更');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => preview(page).evaluate((element) => element.matches(':modal')))
    .toBe(true);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect
    .poll(() => preview(page).evaluate((element) => element.matches(':modal')))
    .toBe(false);
  await createEmptyThread(page);
  await expectThreadReady(page);
  await expect(preview(page)).toHaveCount(0);
});

test('empty and unsupported patches have explicit feedback', async ({ page }) => {
  await send(page, '[diff-preview-empty]');
  await trigger(page).click();
  await expect(preview(page).getByText('暂无文件变更')).toBeVisible();
  await screenshot(page, 'empty');
  await page.keyboard.press('Escape');
  await send(page, '[diff-preview-invalid]');
  await trigger(page).last().click();
  await expect(preview(page).getByRole('alert')).toContainText('无法读取变更内容');
});

test('read failures can be retried and closing cancels a pending read', async ({ page }) => {
  await send(page);
  const path = '**/api/threads/*';
  await page.route(path, (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'READ_FAILED', message: '会话历史暂时无法读取' } },
    }),
  );
  await trigger(page).click();
  await expect(preview(page).getByRole('alert')).toContainText('会话历史暂时无法读取');
  await screenshot(page, 'read-failure');
  await page.unroute(path);
  await preview(page).getByRole('button', { name: '重新加载' }).click();
  await expect(preview(page).locator('.diff-table')).toBeVisible();
  await page.keyboard.press('Escape');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(path, async (route) => {
    await pending;
    await route.continue().catch(() => {});
  });
  await trigger(page).click();
  await expect(preview(page).getByText('正在读取变更…')).toBeVisible();
  await preview(page).getByRole('button', { name: '关闭代码变更预览' }).click();
  release();
  await page.unroute(path);
  await expect(preview(page)).toHaveCount(0);
  await trigger(page).click();
  await expect(preview(page).locator('.diff-table')).toBeVisible();
});
