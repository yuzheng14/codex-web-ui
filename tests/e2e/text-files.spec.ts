import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadView } from '../../src/shared/types';
import { PLAIN_TEXT_EXTENSIONS } from '../../src/shared/file-preview';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';

const preview = (page: Page, kind = 'TXT') =>
  page.getByRole('dialog', { name: `${kind} 文件预览`, exact: true });
const fileLink = (page: Page) => page.getByRole('link', { name: '阅读文本', exact: true });
const original =
  '\uFEFFTXT 文件预览 · Covro\r\n\r\n中文、English、符号 & < > " ✓\r\n' +
  '  两个空格缩进\r\n\tTab 缩进\r\n\r\n' +
  '# Markdown 标题按原文显示\r\n**不加粗** [不打开链接](https://example.com)\r\n' +
  '<script>window.textInjected = true</script>\r\n<img src=x onerror=alert(1)>\r\n\r\n' +
  '长行：' +
  'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(12) +
  '\r\n\r\n' +
  Array.from({ length: 80 }, (_, i) => `${i + 1}. 阅读文本，保留每一行的内容和空白。`).join(
    '\r\n',
  ) +
  '\r\n';

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/covro-text-preview-${name}.png`, animations: 'disabled' });
}

test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const thread = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  await mkdir(join(thread.cwd, 'docs'), { recursive: true });
  await writeFile(join(thread.cwd, 'docs/阅读 说明.TXT'), original);
  await writeFile(join(thread.cwd, 'docs/empty.txt'), '');
  await writeFile(join(thread.cwd, 'docs/huge.txt'), '');
  await truncate(join(thread.cwd, 'docs/huge.txt'), 2 * 1024 * 1024 + 1);
  await writeFile(join(thread.cwd, 'docs/binary.txt'), Buffer.from([0xff, 0xfe]));
  await writeFile(join(thread.cwd, 'docs/text.md'), '# 使用说明\n\n[打开文本](<阅读 说明.TXT>)');
  for (const extension of PLAIN_TEXT_EXTENSIONS.filter((extension) => extension !== 'txt'))
    await writeFile(join(thread.cwd, `docs/sample.${extension}`), '名称,状态\n\tCovro,只读\n');
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[text-files] 请整理文本产出');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
});

test('desktop uses the shared reader, preserves literal text and copying, and follows relative links', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('link', { name: '使用说明', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Markdown 文件预览' })
    .getByRole('link', { name: '打开文本' })
    .click();
  const source = preview(page).getByLabel('TXT 原文');
  expect(await source.textContent()).toBe(original);
  await expect(source.locator('script, img, a, h1, strong')).toHaveCount(0);
  const panel = (await preview(page).boundingBox())!;
  const main = (await page.locator('.main-panel').boundingBox())!;
  expect(main.x + main.width).toBeLessThanOrEqual(panel.x + 1);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('边读边继续讨论');
  await preview(page).getByRole('button', { name: '复制原文' }).click();
  await expect(preview(page).locator('.file-preview-feedback')).toHaveText('已复制 TXT 原文');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
  await screenshot(page, 'desktop');
  await preview(page).getByRole('button', { name: '自动换行' }).click();
  await expect(source).toHaveCSS('white-space', 'pre');
  const scroll = preview(page).getByLabel('文件内容', { exact: true });
  expect(await scroll.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await preview(page).getByRole('button', { name: '自动换行' }).click();
  await expect(source).toHaveCSS('white-space', 'pre-wrap');
  await page.keyboard.press('Escape');
  await expect(preview(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '边读边继续讨论',
  );
  for (const name of ['绝对路径', '本地文件']) {
    await page.getByRole('link', { name, exact: true }).click();
    expect(await preview(page).getByLabel('TXT 原文').textContent()).toBe(original);
    await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
  }
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const thread = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(await readFile(join(thread.cwd, 'docs/阅读 说明.TXT'), 'utf8')).toBe(original);
  for (const extension of PLAIN_TEXT_EXTENSIONS.filter((extension) => extension !== 'txt')) {
    const kind = extension.toUpperCase();
    await page.getByRole('link', { name: kind, exact: true }).click();
    expect(await preview(page, kind).getByLabel(`${kind} 原文`).textContent()).toBe(
      '名称,状态\n\tCovro,只读\n',
    );
    await preview(page, kind).getByRole('button', { name: '关闭文件预览' }).click();
  }
});

for (const width of [390, 320]) {
  test(`${width}px: full-screen text, independent scrolling and return to the conversation`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await fileLink(page).click();
    await expect(preview(page).getByLabel('TXT 原文')).toBeVisible();
    expect(await preview(page).evaluate((node) => node.matches(':modal'))).toBe(true);
    const panel = (await preview(page).boundingBox())!;
    expect(panel.x).toBe(0);
    expect(panel.width).toBe(width);
    const chatScroll = await page
      .locator('.conversation-scroll')
      .evaluate((node) => node.scrollTop);
    await screenshot(page, `mobile-${width}`);
    const body = preview(page).getByLabel('文件内容', { exact: true });
    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(preview(page).getByRole('button', { name: '复制原文' })).toBeInViewport();
    await expect(preview(page).getByRole('button', { name: '关闭文件预览' })).toBeInViewport();
    await preview(page).getByRole('button', { name: '复制原文' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
    await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
    await expect(fileLink(page)).toBeFocused();
    expect(await page.locator('.conversation-scroll').evaluate((node) => node.scrollTop)).toBe(
      chatScroll,
    );
  });
}

test('empty, missing, oversized and invalid files show states; retry and clipboard fallback work', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: '空文件', exact: true }).click();
  await expect(preview(page).getByText('此文件为空。')).toBeVisible();
  await expect(preview(page).getByRole('button', { name: '复制原文' })).toBeEnabled();
  await screenshot(page, 'empty');
  await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
  for (const [name, message, state] of [
    ['缺失文件', '不存在或已被删除', 'missing'],
    ['超大文件', '2 MiB', 'oversized'],
    ['无效编码', 'UTF-8', 'encoding'],
  ]) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(preview(page).getByRole('alert')).toContainText(message!);
    await expect(preview(page).getByRole('button', { name: '复制原文' })).toBeDisabled();
    await screenshot(page, state!);
    await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
  }
  await page.getByRole('link', { name: '缺失文件', exact: true }).click();
  await expect(preview(page).getByRole('alert')).toBeVisible();
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const thread = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  await writeFile(join(thread.cwd, 'docs/missing.txt'), '已恢复\n  保留缩进');
  await preview(page).getByRole('button', { name: '重新加载' }).click();
  await expect(preview(page).getByLabel('TXT 原文')).toHaveText('已恢复\n  保留缩进');
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }),
  );
  await preview(page).getByRole('button', { name: '复制原文' }).click();
  await expect(preview(page).locator('.file-preview-feedback')).toContainText('复制失败');
  await expect(preview(page).getByLabel('TXT 原文')).toBeFocused();
});

test('loading can be closed without stale results, and changing threads closes the reader', async ({
  page,
}) => {
  await page.route('**/text?**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue().catch(() => {});
  });
  await fileLink(page).click();
  await expect(preview(page).getByText('正在加载文件…')).toBeVisible();
  await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
  await expect(preview(page)).toHaveCount(0);
  await page.unroute('**/text?**');
  await fileLink(page).click();
  await expect(preview(page).getByLabel('TXT 原文')).toBeVisible();
  await createEmptyThread(page);
  await expectThreadReady(page);
  await expect(preview(page)).toHaveCount(0);
});
