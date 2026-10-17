import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  expectThreadReady,
} from './helpers';

const evidence = '/tmp/codex-activity-evidence';
const activities = (page: Page) => page.locator('details.activity');
const header = (activity: Locator) => activity.locator(':scope > summary');

async function startScenario(page: Page, streaming = false) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  const navigation = page.getByRole('button', { name: '打开项目与会话', exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await createThreadButton(page).click();
  await expectThreadReady(page);
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill(`${streaming ? '[activity-stream]' : '[activity-collapse]'} 检查长输出与文件变更`);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.activity-group').first()).toBeVisible();
  if (!streaming) {
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await expect(activities(page)).toHaveCount(4);
  }
  for (const group of await page.locator('.activity-group').all()) await header(group).click();
  await expect(activities(page).first()).toBeVisible();
}

async function geometry(activity: Locator) {
  return activity.evaluate((element) => {
    const scroll = element.closest('.conversation-scroll')!;
    const summary = element.querySelector(':scope > summary')!;
    const groupHeader = element.closest('.activity-group')?.querySelector(':scope > summary');
    return {
      activityTop: element.getBoundingClientRect().top,
      activityBottom: element.getBoundingClientRect().bottom,
      headerTop: summary.getBoundingClientRect().top,
      headerBottom: summary.getBoundingClientRect().bottom,
      scrollTop:
        scroll.getBoundingClientRect().top +
        (scroll.parentElement!.querySelector('.sticky-prompt')?.getBoundingClientRect().height ??
          0) +
        (groupHeader?.getBoundingClientRect().height ?? 0),
      scrollBottom: scroll.getBoundingClientRect().bottom,
    };
  });
}

async function scrollInside(activity: Locator) {
  await activity.evaluate((element) => {
    const scroll = element.closest('.conversation-scroll')!;
    scroll.scrollTop +=
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 700;
  });
  await expect
    .poll(async () => {
      const box = await geometry(activity);
      return Math.abs(box.headerTop - box.scrollTop);
    })
    .toBeLessThanOrEqual(2);
  const box = await geometry(activity);
  expect(box.activityTop).toBeLessThan(box.scrollTop - 500);
  expect(box.activityBottom).toBeGreaterThan(box.scrollBottom);
}

async function expectCollapseAnchor(activity: Locator) {
  await expect(activity).not.toHaveAttribute('open');
  await expect
    .poll(async () => {
      const box = await geometry(activity);
      return box.headerTop - box.scrollTop;
    })
    .toBeGreaterThanOrEqual(0);
  const box = await geometry(activity);
  expect(box.headerTop - box.scrollTop).toBeLessThanOrEqual(16);
  expect(box.headerBottom).toBeLessThan(box.scrollBottom);
  await expect(header(activity)).toBeFocused();
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
  test(`${viewport.name} keeps long command and diff headers available and restores the collapse anchor`, async ({
    page,
  }) => {
    await startScenario(page);
    await page.setViewportSize(viewport);
    for (const activity of await activities(page).all())
      await expect(activity).not.toHaveAttribute('open');
    await page.locator('.conversation-scroll').evaluate((element) => (element.scrollTop = 0));
    await screenshot(page, `activity-collapsed-${viewport.name}`);

    const command = activities(page).nth(0);
    await header(command).click();
    await expect(command).toHaveAttribute('open', '');
    await expect(command.locator('.tool-output')).toContainText('unit-test 140: passed');
    await scrollInside(command);
    await screenshot(page, `activity-command-pinned-${viewport.name}`);
    await header(command).click();
    await expectCollapseAnchor(command);
    await screenshot(page, `activity-command-collapsed-anchor-${viewport.name}`);

    const file = activities(page).nth(1);
    await header(file).focus();
    await header(file).press('Enter');
    await expect(file).toHaveAttribute('open', '');
    await expect(file.locator('.diff')).toContainText('updatedValue100');
    await scrollInside(file);
    await screenshot(page, `activity-diff-pinned-${viewport.name}`);
    await header(file).press('Space');
    await expectCollapseAnchor(file);
    await expect(command).not.toHaveAttribute('open');
    await screenshot(page, `activity-diff-collapsed-anchor-${viewport.name}`);
  });

  test(`${viewport.name} binds each sticky header to its own activity and removes it after leaving the block`, async ({
    page,
  }) => {
    await startScenario(page);
    await page.setViewportSize(viewport);
    const first = activities(page).nth(0);
    const file = activities(page).nth(1);
    const second = activities(page).nth(2);
    for (const activity of [first, file, second]) {
      await header(activity).click();
      await expect(activity).toHaveAttribute('open', '');
    }
    await scrollInside(file);
    const preceding = await geometry(first);
    expect(preceding.headerBottom).toBeLessThanOrEqual(preceding.scrollTop);
    await expect(header(file)).toContainText('文件变更');
    await screenshot(page, `activity-multiple-diff-pinned-${viewport.name}`);

    await scrollInside(second);
    const previousFile = await geometry(file);
    expect(previousFile.headerBottom).toBeLessThanOrEqual(previousFile.scrollTop);
    await expect(header(second)).toContainText('pnpm build -- --mode=production');
    await header(second).click();
    await expectCollapseAnchor(second);
    await expect(first).toHaveAttribute('open', '');
    await expect(file).toHaveAttribute('open', '');

    await page.locator('.conversation-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(async () => {
        const box = await geometry(activities(page).last());
        return box.headerBottom - box.scrollTop;
      })
      .toBeLessThan(0);
    const topStillHasActivity = await page.locator('.conversation-scroll').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return Boolean(
        document.elementFromPoint(box.x + box.width / 2, box.y + 12)?.closest('.activity'),
      );
    });
    expect(topStillHasActivity).toBe(false);
    await screenshot(page, `activity-left-block-${viewport.name}`);
  });

  test(`${viewport.name} preserves manually expanded and collapsed state through streamed output and completion`, async ({
    page,
  }) => {
    await startScenario(page, true);
    await page.setViewportSize(viewport);
    const command = activities(page).first();
    await expect(command).not.toHaveAttribute('open');
    await header(command).click();
    await scrollInside(command);
    await expect(command.locator('.tool-output')).toContainText('stream-update-1');
    await expect(command).toHaveAttribute('open', '');
    const box = await geometry(command);
    expect(Math.abs(box.headerTop - box.scrollTop)).toBeLessThanOrEqual(2);
    await screenshot(page, `activity-stream-open-${viewport.name}`);

    await header(command).click();
    await expect(command).not.toHaveAttribute('open');
    await expect(command.locator('.tool-output')).toContainText('stream-update-2');
    await expect(command).not.toHaveAttribute('open');
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await expect(command).not.toHaveAttribute('open');
    await expect(activities(page)).toHaveCount(4);
    await header(command).scrollIntoViewIfNeeded();
    await screenshot(page, `activity-stream-closed-${viewport.name}`);
  });

  test(`${viewport.name} keeps the reading position when a long activity is expanded before more output arrives`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await startScenario(page, true);
    const command = activities(page).first();
    const scroll = page.locator('.conversation-scroll');
    await expect(page.getByRole('button', { name: '回到最新内容', exact: true })).toHaveCount(0);
    await header(command).click();
    await expect(command).toHaveAttribute('open', '');
    // Expanding changes scrollHeight without any user scroll. It must stop automatic following.
    await expect(page.getByRole('button', { name: '回到最新内容', exact: true })).toBeVisible();
    const readingPosition = await scroll.evaluate((element) => element.scrollTop);

    await expect(command.locator('.tool-output')).toContainText('stream-update-1');
    const afterOutput = await scroll.evaluate(async (element) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return element.scrollTop;
    });
    expect(Math.abs(afterOutput - readingPosition)).toBeLessThanOrEqual(2);
    await expect(header(command)).toBeInViewport();

    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await expect(activities(page)).toHaveCount(4);
    expect(
      Math.abs((await scroll.evaluate((element) => element.scrollTop)) - readingPosition),
    ).toBeLessThanOrEqual(2);
    await expect(command).toHaveAttribute('open', '');
    await expect(header(command)).toBeInViewport();
  });
}
