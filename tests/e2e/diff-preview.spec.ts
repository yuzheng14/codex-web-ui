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

test('desktop lists every snapshot file, preserves inline edits and navigates within a file', async ({
  page,
}) => {
  await send(page);
  await trigger(page).click();
  const files = preview(page).getByRole('region');
  await expect(files).toHaveCount(5);
  await expect(preview(page).getByRole('combobox')).toHaveCount(0);
  await expect(preview(page).getByText('此快照共 5 个文件')).toBeVisible();
  const first = files.first();
  await expect(first.locator('.diff-file-heading')).toContainText('src/预览 workspace.ts');
  await expect(first.locator('.diff-removed .diff-inline-change').first()).toHaveText('terminal');
  await expect(first.locator('.diff-added .diff-inline-change').first()).toHaveText('web');
  await expect(first.locator('.diff-added').nth(1).locator('mark')).toHaveCount(0);
  await expect(first.locator('.diff-line-number').first()).toHaveText('1');
  const panel = (await preview(page).boundingBox())!,
    main = (await page.locator('.main-panel').boundingBox())!;
  expect(main.x + main.width).toBeLessThanOrEqual(panel.x + 1);
  const chatScroll = await page
    .locator('.conversation-scroll')
    .evaluate((element) => element.scrollTop);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('保留讨论草稿');
  await first.getByRole('button', { name: '下一个变更区块' }).click();
  expect(
    await preview(page)
      .getByLabel('变更文件列表')
      .evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
  const content = first.getByLabel('src/预览 workspace.ts 的变更内容', { exact: true });
  await content.evaluate((element) => {
    element.scrollLeft = 200;
  });
  expect(await content.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await preview(page).getByRole('button', { name: '自动换行' }).click();
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await expect(files.nth(1).locator('.diff-stats')).toHaveText('+2−0');
  await expect(files.nth(2).locator('.diff-stats')).toHaveText('+0−1');
  await expect(files.nth(3)).toContainText('二进制文件已变更');
  await expect(files.nth(4).locator('.diff-rename')).toContainText('docs/guide.md');
  await page.keyboard.press('Escape');
  await expect(trigger(page)).toBeFocused();
  expect(await page.locator('.conversation-scroll').evaluate((element) => element.scrollTop)).toBe(
    chatScroll,
  );
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '保留讨论草稿',
  );
});

for (const width of [1600, 390, 320]) {
  test(`${width}px: mixed lengths list all files, lazily expand long diffs and collapse without losing the header`, async ({
    page,
  }) => {
    await send(page, '[diff-preview-mixed]');
    await page.setViewportSize({ width, height: width === 1600 ? 1000 : 844 });
    await trigger(page).click();
    const files = preview(page).getByRole('region');
    await expect(files).toHaveCount(6);
    await expect(preview(page).locator('.diff-table')).toHaveCount(3);
    expect(await preview(page).evaluate((element) => element.matches(':modal'))).toBe(width < 1280);
    const large = files.last();
    await expect(large.getByRole('button', { name: '展开变更' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(large).toContainText('480 行，超过 300 行，默认折叠');
    await expect(large.locator('.diff-table')).toHaveCount(0);
    await expect(large).not.toContainText('截断');
    await preview(page).getByRole('button', { name: '自动换行' }).click();
    await screenshot(page, `list-${width}`);
    await large.scrollIntoViewIfNeeded();
    await screenshot(page, `collapsed-${width}`);
    const top = await large.evaluate((element) => element.getBoundingClientRect().top);
    await large.getByRole('button', { name: '展开变更' }).click();
    await expect(large.locator('.diff-added')).toHaveCount(480);
    expect(
      Math.abs((await large.evaluate((element) => element.getBoundingClientRect().top)) - top),
    ).toBeLessThan(2);
    await large.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await screenshot(page, `expanded-${width}`);
    await large.getByRole('button', { name: '收起变更' }).last().click();
    await expect(large.locator('.diff-table')).toHaveCount(0);
    await expect(large.getByRole('button', { name: '展开变更' })).toBeFocused();
    await expect(large.getByRole('heading')).toBeInViewport();
    await large.getByRole('button', { name: '展开变更' }).click();
    await large.getByRole('button', { name: '收起变更' }).first().click();
    await expect(large.locator('.diff-table')).toHaveCount(0);
    // Short files have independent disclosures and retain all rows when reopened.
    await files.nth(1).getByRole('button', { name: '收起变更' }).click();
    await expect(files.nth(1).locator('.diff-table')).toHaveCount(0);
    await files.nth(1).getByRole('button', { name: '展开变更' }).click();
    await expect(files.nth(1).locator('.diff-added')).toHaveCount(2);
    await expect(preview(page).getByRole('button', { name: '关闭代码变更预览' })).toBeInViewport();
    await preview(page).getByRole('button', { name: '关闭代码变更预览' }).click();
    await expect(trigger(page)).toBeFocused();
  });
}

test('volume folding and upstream truncation remain distinct', async ({ page }) => {
  await send(page, '[diff-preview-volume]');
  await page.route('**/api/threads/*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), historyTruncated: true } });
  });
  await trigger(page).click();
  await expect(preview(page).getByText('补丁已被截断，以下仅展示收到的部分内容。')).toBeVisible();
  const large = preview(page).getByRole('region', { name: 'src/large-line.ts', exact: true });
  await expect(large).toContainText('超过 50,000 字符');
  await expect(large.locator('.diff-table')).toHaveCount(0);
  await large.getByRole('button', { name: '展开变更' }).click();
  await expect(large.locator('.diff-added')).toHaveCount(1);
  await expect(preview(page).getByText('补丁已被截断，以下仅展示收到的部分内容。')).toBeVisible();
});

test('tool entry reveals a long file; thread changes and responsive mode release the preview', async ({
  page,
}) => {
  await send(page, '[diff-preview-mixed]');
  await page.locator('details.activity-group > summary').click();
  await page.locator('details.activity > summary').click();
  await page.getByRole('button', { name: /src\/generated\/large.ts.*查看变更/ }).click();
  await expect(
    preview(page)
      .getByRole('region', { name: 'src/generated/large.ts', exact: true })
      .getByRole('heading'),
  ).toBeInViewport();
  await expect(
    preview(page)
      .getByRole('region', { name: 'src/generated/large.ts', exact: true })
      .locator('.diff-added'),
  ).toHaveCount(480);
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
  await expect(preview(page).locator('.diff-table').first()).toBeVisible();
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
  await expect(preview(page).locator('.diff-table').first()).toBeVisible();
});

for (const width of [1600, 390]) {
  test(`${width}px: highlights separate inline edits while keeping complete source text`, async ({
    page,
  }) => {
    await send(page, '[diff-preview-inline]');
    await page.setViewportSize({ width, height: width === 1600 ? 1000 : 844 });
    await trigger(page).click();
    await expect(preview(page).locator('.diff-removed .diff-inline-change')).toHaveText([
      'light',
      '3',
      '👩🏽‍💻',
    ]);
    await expect(preview(page).locator('.diff-added .diff-inline-change')).toHaveText([
      'dark',
      '5',
      'Name',
      '👨🏻‍💻',
    ]);
    await expect(
      preview(page)
        .locator('.diff-added')
        .filter({ hasText: 'newly added explanation' })
        .locator('mark'),
    ).toHaveCount(0);
    await expect(preview(page).locator('.diff-added .diff-code').first()).toHaveText(
      '  const mode = "dark"; const retries = 5;',
    );
    if (width < 1280) await preview(page).getByRole('button', { name: '自动换行' }).click();
    await screenshot(page, `inline-${width}`);
  });
}

for (const width of [1600, 390, 320]) {
  test(`${width}px: keeps the current file heading pinned and collapses from the reading position`, async ({
    page,
  }) => {
    await send(page, '[diff-preview-mixed]');
    await page.setViewportSize({ width, height: width === 1600 ? 1000 : 844 });
    await trigger(page).click();
    const file = preview(page).getByRole('region', { name: 'src/generated/large.ts', exact: true });
    const scroller = preview(page).getByLabel('变更文件列表');
    await file.getByRole('button', { name: '展开变更' }).click();
    await file.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await scroller.evaluate((element) => {
      element.scrollTop += 600;
    });
    const pinnedTop =
      (await scroller.boundingBox())!.y +
      (await scroller.evaluate((element) => parseFloat(getComputedStyle(element).paddingTop)));
    const heading = file.locator('.diff-file-heading');
    await expect(heading.getByRole('button', { name: '收起变更' })).toBeInViewport();
    expect(Math.abs((await heading.boundingBox())!.y - pinnedTop)).toBeLessThan(2);
    expect((await file.boundingBox())!.y).toBeLessThan((await scroller.boundingBox())!.y - 400);
    await screenshot(page, `sticky-${width}`);
    await heading.getByRole('button', { name: '收起变更' }).click();
    await expect(file.locator('.diff-table')).toHaveCount(0);
    await expect(heading.getByRole('button', { name: '展开变更' })).toBeFocused();
    await expect(file.getByRole('heading')).toBeInViewport();
    // The previous heading must leave with its file; the next owns the pinned controls.
    const next = preview(page).getByRole('region', { name: 'docs/新功能.md', exact: true });
    await next.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await scroller.evaluate((element) => {
      element.scrollTop += 40;
    });
    const nextHeading = next.locator('.diff-file-heading');
    expect(Math.abs((await nextHeading.boundingBox())!.y - pinnedTop)).toBeLessThan(2);
    const previousHeading = preview(page)
      .getByRole('region', { name: 'src/预览 workspace.ts', exact: true })
      .locator('.diff-file-heading');
    const previousBox = (await previousHeading.boundingBox())!;
    expect(previousBox.y + previousBox.height).toBeLessThanOrEqual(pinnedTop + 1);
    await expect(nextHeading.getByRole('button', { name: '收起变更' })).toBeInViewport();
  });

  test(`${width}px: hunk navigation leaves the target below the pinned file heading`, async ({
    page,
  }) => {
    await send(page);
    await page.setViewportSize({ width, height: width === 1600 ? 1000 : 844 });
    await trigger(page).click();
    const file = preview(page).getByRole('region', { name: 'src/预览 workspace.ts', exact: true });
    await file.getByRole('button', { name: '下一个变更区块' }).click();
    const heading = (await file.locator('.diff-file-heading').boundingBox())!;
    const hunk = file.locator('.diff-hunk').nth(1);
    expect((await hunk.boundingBox())!.y).toBeGreaterThanOrEqual(heading.y + heading.height);
    await expect(hunk).toBeInViewport();
    await file.getByRole('button', { name: '上一个变更区块' }).click();
    const restoredHeading = (await file.locator('.diff-file-heading').boundingBox())!;
    expect((await file.locator('.diff-hunk').first().boundingBox())!.y).toBeGreaterThanOrEqual(
      restoredHeading.y + restoredHeading.height,
    );
  });
}
