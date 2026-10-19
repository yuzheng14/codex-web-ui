import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadView } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';

const preview = (page: Page) => page.getByRole('dialog', { name: 'JSON 文件预览', exact: true });
const original =
  '\uFEFF{"项目":"Covro","状态":{"只读":true,"重试":false,"备注":null},"计数":9007199254740993,"步骤":' +
  JSON.stringify(
    Array.from({ length: 24 }, (_, i) => ({
      序号: i + 1,
      说明: '预览 JSON 文件，边读边继续讨论。',
    })),
  ) +
  '}\r\n';
const invalid = '{\n  "名称": "未完成的配置",\n  "说明": "<img src=x onerror=alert(1)>",\n}\n';

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/covro-json-preview-${name}.png`, animations: 'disabled' });
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
  await writeFile(join(thread.cwd, 'docs/项目 配置.JSON'), original);
  await writeFile(join(thread.cwd, 'docs/list.json'), '["中文",1,true,null,{"嵌套":[[],{}]}]');
  await writeFile(join(thread.cwd, 'docs/invalid.json'), invalid);
  await writeFile(join(thread.cwd, 'docs/huge.json'), '{}');
  await truncate(join(thread.cwd, 'docs/huge.json'), 2 * 1024 * 1024 + 1);
  await writeFile(
    join(thread.cwd, 'docs/json.md'),
    '# JSON 使用说明\n\n[打开配置](<项目 配置.JSON>)',
  );
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[json-files] 请整理配置文件');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
});

test('desktop shares the Markdown reader, formats and highlights without changing the source, and switches files', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('link', { name: '使用说明', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Markdown 文件预览', exact: true })
    .getByRole('link', { name: '打开配置', exact: true })
    .click();
  await expect(preview(page).getByLabel('格式化 JSON')).toContainText('9007199254740993');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  for (const kind of ['key', 'string', 'number', 'boolean', 'null'])
    await expect(preview(page).locator(`.json-${kind}`).first()).toBeVisible();
  const panel = (await preview(page).boundingBox())!;
  const main = (await page.locator('.main-panel').boundingBox())!;
  expect(main.x + main.width).toBeLessThanOrEqual(panel.x + 1);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('保持只读，继续讨论');
  await preview(page).getByRole('button', { name: '复制原文' }).click();
  await expect(preview(page).getByRole('status')).toHaveText('已复制 JSON 原文');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
  await screenshot(page, 'desktop');
  await preview(page).getByRole('button', { name: '原文', exact: true }).click();
  expect(await preview(page).getByLabel('JSON 原文').textContent()).toBe(original);
  await preview(page).getByRole('button', { name: '预览', exact: true }).click();
  await expect(preview(page).getByLabel('格式化 JSON')).toBeVisible();
  await page.getByRole('link', { name: '数组', exact: true }).click();
  await expect(preview(page).getByLabel('格式化 JSON')).toContainText('嵌套');
  for (const name of ['绝对路径', '本地文件']) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(preview(page).getByLabel('格式化 JSON')).toContainText('Covro');
  }
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const thread = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  expect(await readFile(join(thread.cwd, 'docs/项目 配置.JSON'), 'utf8')).toBe(original);
  await page.keyboard.press('Escape');
  await expect(preview(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toHaveValue(
    '保持只读，继续讨论',
  );
});

for (const width of [390, 320]) {
  test(`${width}px: modal reading, scrolling, source copy and focus restoration`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const link = page.getByRole('link', { name: '配置文件', exact: true });
    await link.click();
    await expect(preview(page).getByLabel('格式化 JSON')).toBeVisible();
    expect(await preview(page).evaluate((node) => node.matches(':modal'))).toBe(true);
    const panel = (await preview(page).boundingBox())!;
    expect(panel.x).toBe(0);
    expect(panel.width).toBe(width);
    const chatScroll = await page
      .locator('.conversation-scroll')
      .evaluate((node) => node.scrollTop);
    await preview(page)
      .getByLabel('文件内容', { exact: true })
      .evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
    await expect(preview(page).getByRole('button', { name: '关闭文件预览' })).toBeInViewport();
    await expect(preview(page).getByRole('button', { name: '复制原文' })).toBeInViewport();
    await preview(page)
      .getByLabel('文件内容', { exact: true })
      .evaluate((node) => {
        node.scrollTop = 0;
      });
    await screenshot(page, `mobile-${width}`);
    await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
    await expect(link).toBeFocused();
    expect(await page.locator('.conversation-scroll').evaluate((node) => node.scrollTop)).toBe(
      chatScroll,
    );
  });
}

test('invalid JSON preserves safe, copyable source; missing and oversized files show errors and can retry', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: '无效 JSON', exact: true }).click();
  await expect(preview(page).getByRole('alert')).toContainText('JSON 格式无效');
  expect(await preview(page).getByLabel('JSON 原文').textContent()).toBe(invalid);
  await expect(preview(page).locator('img')).toHaveCount(0);
  await preview(page).getByRole('button', { name: '复制原文' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(invalid);
  await screenshot(page, 'invalid');
  await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
  await page.getByRole('link', { name: '超大文件', exact: true }).click();
  await expect(preview(page).getByRole('alert')).toContainText('2 MiB');
  await expect(preview(page).getByRole('button', { name: '复制原文' })).toBeDisabled();
  await screenshot(page, 'oversized');
  await preview(page).getByRole('button', { name: '关闭文件预览' }).click();
  await page.getByRole('link', { name: '缺失文件', exact: true }).click();
  await expect(preview(page).getByRole('alert')).toContainText('不存在或已被删除');
  await screenshot(page, 'missing');
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const thread = (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  await writeFile(join(thread.cwd, 'docs/missing.json'), '{"已恢复":true}');
  await preview(page).getByRole('button', { name: '重新加载' }).click();
  await expect(preview(page).getByLabel('格式化 JSON')).toContainText('已恢复');
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }),
  );
  await preview(page).getByRole('button', { name: '复制原文' }).click();
  await expect(preview(page).getByLabel('JSON 原文')).toHaveText('{"已恢复":true}');
  await expect(preview(page).locator('.file-preview-feedback')).toContainText('复制失败');
});
