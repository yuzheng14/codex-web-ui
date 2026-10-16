import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  expectThreadReady,
} from './helpers';

const evidence = join(tmpdir(), 'codex-sticky-prompt-evidence');
const sticky = (page: Page) => page.getByRole('button', { name: '查看完整 Prompt', exact: true });
const prompts = (page: Page) => page.locator('.conversation-content .user-message');
const scrollBox = (page: Page) => page.locator('.conversation-scroll');
const fullPrompt = (page: Page) => page.getByRole('dialog', { name: '完整 Prompt', exact: true });
const longPrompt =
  '[sticky-prompt] 请实现用户 Prompt 吸顶，并在吸顶时只显示一行内容。\n' +
  Array.from(
    { length: 48 },
    (_, index) =>
      `要求 ${index + 1}：阅读长回复时保留当前上下文，支持多轮切换和窄屏，保持页面布局稳定。`,
  ).join('\n') +
  '\n    return "完整内容的最后一行";\n';

async function openNavigation(page: Page) {
  const button = page.getByRole('button', { name: '打开项目与会话', exact: true });
  if (await button.isVisible()) await button.click();
}

async function newThread(page: Page) {
  await openNavigation(page);
  await createThreadButton(page).click();
  await expectThreadReady(page);
}

async function start(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await newThread(page);
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}

async function movePrompt(prompt: Locator, offset: number) {
  return prompt.evaluate((element, offset) => {
    const scroll = element.closest('.conversation-scroll')!;
    scroll.scrollTop +=
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset;
    return scroll.scrollTop;
  }, offset);
}

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' });
}

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
});
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} pins one line without moving content and opens the complete long prompt`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await start(page);
    await send(page, longPrompt);
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await scrollBox(page).evaluate((element) => (element.scrollTop = 0));
    await expect(sticky(page)).toHaveCount(0);
    await expect(prompts(page).locator('.user-text')).toHaveJSProperty('textContent', longPrompt);
    const originalHeight = (await prompts(page).boundingBox())!.height;
    await screenshot(page, `before-${viewport.name}`);

    const position = await movePrompt(prompts(page).first(), -250);
    await expect(sticky(page)).toBeVisible();
    expect(await scrollBox(page).evaluate((element) => element.scrollTop)).toBe(position);
    expect((await prompts(page).boundingBox())!.height).toBe(originalHeight);
    expect((await sticky(page).boundingBox())!.height).toBe(40);
    const textBox = await page.locator('.sticky-prompt-text').evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      truncated: element.scrollWidth > element.clientWidth,
      overflow: getComputedStyle(element).textOverflow,
    }));
    expect(textBox.height).toBe(textBox.lineHeight);
    expect(textBox.truncated).toBe(true);
    expect(textBox.overflow).toBe('ellipsis');

    // Read the reply well below a prompt taller than the viewport.
    await prompts(page)
      .first()
      .evaluate((element) => {
        const scroll = element.closest('.conversation-scroll')!;
        scroll.scrollTop +=
          element.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top + 180;
      });
    await screenshot(page, `pinned-${viewport.name}`);
    const readingPosition = await scrollBox(page).evaluate((element) => element.scrollTop);
    await sticky(page).focus();
    await sticky(page).press('Enter');
    await expect(fullPrompt(page)).toBeVisible();
    await expect(fullPrompt(page).locator('.user-text')).toHaveJSProperty(
      'textContent',
      longPrompt,
    );
    expect(
      await fullPrompt(page)
        .locator('.prompt-dialog-content')
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    await fullPrompt(page)
      .locator('.prompt-dialog-content')
      .evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
    await expect(
      fullPrompt(page).getByText('完整内容的最后一行', { exact: false }),
    ).toBeInViewport();
    await screenshot(page, `full-${viewport.name}`);
    await fullPrompt(page).press('Escape');
    await expect(fullPrompt(page)).toHaveCount(0);
    await expect(sticky(page)).toBeFocused();
    expect(await scrollBox(page).evaluate((element) => element.scrollTop)).toBe(readingPosition);

    await movePrompt(prompts(page).first(), 1);
    await expect(sticky(page)).toHaveCount(0);
    expect((await prompts(page).boundingBox())!.height).toBe(originalHeight);
  });

  test(`${viewport.name} replaces the current prompt at each boundary in both directions and clears it on thread changes`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await start(page);
    const first = '[sticky-prompt] 第一轮：检查滚动时的上下文';
    const second = '[sticky-prompt] 第二轮：核对多轮切换';
    await send(page, first);
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await send(page, second);
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    await movePrompt(prompts(page).first(), -300);
    await expect(sticky(page)).toContainText(first);
    await movePrompt(prompts(page).nth(1), 60);
    await expect(sticky(page)).toContainText(first);
    await movePrompt(prompts(page).nth(1), -1);
    await expect(sticky(page)).toContainText(second);
    await expect(sticky(page)).toHaveCount(1);
    await movePrompt(prompts(page).nth(1), 1);
    await expect(sticky(page)).toContainText(first);
    await movePrompt(prompts(page).nth(1), -250);
    await screenshot(page, `second-turn-${viewport.name}`);
    await sticky(page).click();
    await expect(fullPrompt(page).locator('.user-text')).toHaveText(second);
    await fullPrompt(page).getByRole('button', { name: '关闭完整 Prompt', exact: true }).click();
    await newThread(page);
    await expect(sticky(page)).toHaveCount(0);
    await expect(fullPrompt(page)).toHaveCount(0);
    await expect(prompts(page)).toHaveCount(0);
    await send(page, '[sticky-prompt] 新会话的要求');
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await movePrompt(prompts(page).first(), -200);
    await expect(sticky(page)).toContainText('新会话的要求');
  });

  test(`${viewport.name} preserves the reading position and sticky prompt across streamed replies and resizing`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await start(page);
    await send(page, '[sticky-prompt-stream] 流式回复中保持当前阅读位置');
    await expect(page.locator('.assistant-message')).toContainText('检查项 48');
    await movePrompt(prompts(page).first(), -250);
    await expect(sticky(page)).toContainText('流式回复中保持当前阅读位置');
    const position = await scrollBox(page).evaluate((element) => element.scrollTop);
    await expect(page.locator('.assistant-message')).toContainText('流式补充 1');
    expect(await scrollBox(page).evaluate((element) => element.scrollTop)).toBe(position);
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    expect(await scrollBox(page).evaluate((element) => element.scrollTop)).toBe(position);
    await expect(sticky(page)).toContainText('流式回复中保持当前阅读位置');
    await screenshot(page, `streamed-${viewport.name}`);
    await page.setViewportSize({ width: viewport.name === 'mobile' ? 1280 : 320, height: 844 });
    await expect(sticky(page)).toBeVisible();
    expect((await sticky(page).boundingBox())!.height).toBe(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: '回到最新内容', exact: true }).click();
    await expect
      .poll(() =>
        scrollBox(page).evaluate((element) =>
          Math.abs(
            element.scrollHeight -
              element.scrollTop -
              element.clientHeight -
              Number.parseFloat(
                getComputedStyle(element.querySelector('.conversation-content')!).paddingBottom,
              ),
          ),
        ),
      )
      .toBeLessThanOrEqual(2);
    await expect(sticky(page)).toBeVisible();
  });
}

test('uses a later user requirement in the same turn when it reaches the top', async ({ page }) => {
  await start(page);
  const original = '[activity-stream] 按最初的要求检查执行过程';
  await send(page, original);
  await expect(page.locator('.activity-group').first()).toBeVisible();
  const requirement = `追加要求：只显示一行吸顶内容。\n${longPrompt}`;
  await page.getByRole('textbox', { name: '追加要求', exact: true }).fill(requirement);
  await page.getByRole('button', { name: '追加要求', exact: true }).click();
  await expect(prompts(page)).toHaveCount(2);
  await movePrompt(prompts(page).first(), -1);
  await expect(sticky(page)).toContainText(original);
  await movePrompt(prompts(page).nth(1), -1);
  await expect(sticky(page)).toContainText('追加要求：只显示一行吸顶内容。');
  await sticky(page).click();
  await expect(fullPrompt(page).locator('.user-text')).toHaveJSProperty('textContent', requirement);
  await fullPrompt(page).press('Escape');
  await movePrompt(prompts(page).nth(1), 1);
  await expect(sticky(page)).toContainText(original);
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
});

for (const notice of [
  { marker: '[codex-retry-hold]', selector: '.codex-reconnect-pinned' },
  { marker: '[context-compact-hold]', selector: '.context-compaction-pinned' },
]) {
  test(`keeps the prompt below ${notice.selector}`, async ({ page }) => {
    await start(page);
    await send(page, `${notice.marker} ${longPrompt.replace('[sticky-prompt]', '')}`);
    await expect(page.locator(notice.selector)).toBeVisible();
    await movePrompt(prompts(page).first(), -200);
    await expect(sticky(page)).toBeVisible();
    const noticeBox = (await page.locator(notice.selector).boundingBox())!;
    const bar = (await sticky(page).boundingBox())!;
    expect(bar.y).toBeGreaterThanOrEqual(noticeBox.y + noticeBox.height);
    await page.getByRole('button', { name: '中断', exact: true }).click();
    await expect(page.locator(notice.selector)).toHaveCount(0);
  });
}
