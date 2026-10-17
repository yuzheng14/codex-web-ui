import { expect, test, type Page } from '@playwright/test';
import {
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  expectThreadReady,
} from './helpers';

const blocks = (page: Page) =>
  page.getByRole('article', { name: 'Codex 的回复' }).locator('.markdown-code-block');
const expectedCode = [
  '/Users/demo/projects/codex-web-ui/src/main.ts\n',
  'pnpm build\n  pnpm test -- --run\n\tprintf "你好 & <Codex>"\n\n',
  '# 部署步骤\n\n- **保留 Markdown 原文**\n\n```sh\npnpm start\n```\n',
  'const endpoint = "https://example.com/api/projects/abcdefghijklmnopqrstuvwxyz/threads/abcdefghijklmnopqrstuvwxyz/messages?include=content&format=markdown";\n',
];

test.beforeEach(async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expectThreadReady(page);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('[code-copy] 给出示例');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
});

test('each code block copies exact text with independent, temporary success feedback', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await expect(blocks(page)).toHaveCount(4);
  for (const [index, text] of expectedCode.entries()) {
    const block = blocks(page).nth(index);
    await expect(block.locator('pre code')).toHaveText(text, { useInnerText: false });
    await block.getByRole('button', { name: '复制代码块', exact: true }).click();
    await expect(block.getByRole('status')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  }
  const first = blocks(page).first();
  await expect(blocks(page).last().getByRole('status')).toBeEmpty();
  const heightBeforeCopy = (await first.boundingBox())!.height;
  await first.getByRole('button', { name: '复制代码块' }).click();
  await expect(first.getByRole('status')).toHaveText('已复制');
  expect((await first.boundingBox())!.height).toBe(heightBeforeCopy);
  await page.screenshot({ path: '/tmp/codex-code-copy-desktop.png', animations: 'disabled' });
  await expect(first.getByRole('status')).toBeEmpty();
  // Inline code has no toolbar or copy button.
  await expect(page.locator('.markdown > p code')).toHaveText('pnpm test');
  await expect(page.locator('.markdown').getByRole('button', { name: '复制代码块' })).toHaveCount(
    4,
  );
  await page.reload();
  await expect(blocks(page)).toHaveCount(4);
  await blocks(page).nth(2).getByRole('button', { name: '复制代码块' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedCode[2]);
});

test('streaming keeps the code scroller and keyboard focus, and copies the latest content', async ({
  page,
}) => {
  const block = blocks(page).nth(1);
  await expect(block.locator('pre')).toHaveText('pnpm build\n');
  const button = block.getByRole('button', { name: '复制代码块' });
  const previous = await button.elementHandle();
  await button.focus();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  expect(await button.evaluate((node, old) => node === old, previous)).toBe(true);
  await expect(button).toBeFocused();
  await button.press('Enter');
  await expect(block.getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedCode[1]);
  await expect(blocks(page).first().getByRole('status')).toBeEmpty();
});

for (const width of [320, 390]) {
  test(`${width}px: code scrolls horizontally while the copy button stays accessible`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    const block = blocks(page).last();
    const code = block.locator('pre');
    await code.scrollIntoViewIfNeeded();
    expect(await code.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await page
        .locator('.conversation-scroll')
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await code.focus();
    await code.press('ArrowRight');
    await expect.poll(() => code.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    const button = block.getByRole('button', { name: '复制代码块' });
    await expect(button).toBeInViewport();
    const buttonBounds = await button.boundingBox();
    const codeBounds = await code.boundingBox();
    const blockBounds = await block.boundingBox();
    // The button floats beside the first line rather than adding a toolbar row.
    expect(codeBounds!.y).toBe(blockBounds!.y + 1);
    expect(buttonBounds!.y).toBeGreaterThan(codeBounds!.y);
    expect(buttonBounds!.y + buttonBounds!.height).toBeLessThanOrEqual(
      codeBounds!.y + codeBounds!.height,
    );
    expect(buttonBounds!.x).toBeGreaterThanOrEqual(codeBounds!.x + codeBounds!.width);
    await button.focus();
    await button.press('Space');
    await expect(block.getByRole('status')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedCode[3]);
    if (width === 390)
      await page.screenshot({ path: '/tmp/codex-code-copy-mobile.png', animations: 'disabled' });
  });
}

for (const failure of ['denied', 'unavailable']) {
  test(`clipboard ${failure}: shows a clear error without reporting success and allows retry`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
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
            : {
                writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
              },
      });
    }, failure);
    const block = blocks(page).first();
    const heightBeforeCopy = (await block.boundingBox())!.height;
    await block.getByRole('button', { name: '复制代码块' }).click();
    await expect(block.getByRole('status')).toHaveText('复制失败，请手动选择代码复制。');
    await expect(page.getByText('已复制', { exact: true })).toHaveCount(0);
    expect((await block.boundingBox())!.height).toBe(heightBeforeCopy);
    await page.screenshot({
      path: `/tmp/codex-code-copy-failed-${failure}.png`,
      animations: 'disabled',
    });
    await page.evaluate(() => Reflect.get(window, 'restoreClipboard')());
    await block.getByRole('button', { name: '复制代码块' }).click();
    await expect(block.getByRole('status')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedCode[0]);
  });
}
