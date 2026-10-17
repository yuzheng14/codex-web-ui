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
const groups = (page: Page) => page.locator('details.activity-group');
const header = (activity: Locator) => activity.locator(':scope > summary');
const childActivities = (group: Locator) => group.locator('.activity-group-items > details');

async function sendTask(page: Page, prompt: string) {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
}

async function startScenario(page: Page, prompt = '[activity-collapse] 检查执行过程') {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await createThreadButton(page).click();
  await expectThreadReady(page);
  await sendTask(page, prompt);
  await expect(groups(page).first()).toBeVisible();
}

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    animations: 'disabled',
  });
}

async function pinChild(group: Locator, child: Locator) {
  await child.evaluate((element) => {
    const scroll = element.closest('.conversation-scroll')!;
    scroll.scrollTop +=
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 700;
  });
  await expect
    .poll(() =>
      header(group).evaluate((element) => {
        const top = element.closest('.conversation-scroll')!.getBoundingClientRect().top;
        return Math.abs(element.getBoundingClientRect().top - top);
      }),
    )
    .toBeLessThanOrEqual(2);
  const groupBox = (await header(group).boundingBox())!;
  const childBox = (await header(child).boundingBox())!;
  expect(Math.abs(childBox.y - (groupBox.y + groupBox.height))).toBeLessThanOrEqual(2);
  expect(await child.evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(
    groupBox.y - 500,
  );
}

async function expectAnchor(activity: Locator, parentGroup?: Locator) {
  await expect(activity).not.toHaveAttribute('open');
  await expect
    .poll(async () => {
      const box = (await header(activity).boundingBox())!;
      const anchor = parentGroup
        ? await header(parentGroup).evaluate((element) => element.getBoundingClientRect().bottom)
        : await activity.evaluate(
            (element) => element.closest('.conversation-scroll')!.getBoundingClientRect().top,
          );
      return Math.abs(box.y - anchor - 8);
    })
    .toBeLessThanOrEqual(2);
  await expect(header(activity)).toBeFocused();
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
  test(`${viewport.name} collapses consecutive activities into separate groups with two sticky collapse levels`, async ({
    page,
  }) => {
    await startScenario(page);
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await page.setViewportSize(viewport);
    await expect(groups(page)).toHaveCount(2);
    for (const group of await groups(page).all()) {
      await expect(group).not.toHaveAttribute('open');
      await expect(header(group)).toContainText('2 项活动');
      await expect(childActivities(group)).toHaveCount(2);
      for (const activity of await childActivities(group).all())
        await expect(activity).not.toHaveAttribute('open');
    }
    await expect(page.getByText('先运行完整测试，再检查文件变更。', { exact: true })).toBeVisible();
    await expect(
      page.getByText('第一轮检查完成。下面单独运行构建并检查另一处文件变更。', {
        exact: true,
      }),
    ).toBeVisible();
    await page.locator('.conversation-scroll').evaluate((element) => (element.scrollTop = 0));
    await screenshot(page, `groups-collapsed-${viewport.name}`);

    const group = groups(page).first();
    const child = childActivities(group).first();
    await header(group).click();
    await expect(group).toHaveAttribute('open', '');
    await expect(child).not.toHaveAttribute('open');
    await header(child).click();
    await expect(child).toHaveAttribute('open', '');
    await pinChild(group, child);
    await screenshot(page, `groups-two-sticky-levels-${viewport.name}`);
    await header(child).click();
    await expectAnchor(child, group);
    await expect(group).toHaveAttribute('open', '');

    await header(child).press('Enter');
    await expect(child).toHaveAttribute('open', '');
    await pinChild(group, child);
    await header(group).press('Space');
    await expectAnchor(group);
    await expect(child).toHaveAttribute('open', '');
    await expect(child.locator('.tool-output')).not.toBeVisible();
    await screenshot(page, `groups-collapsed-anchor-${viewport.name}`);
    await header(group).press('Enter');
    await expect(child.locator('.tool-output')).toBeVisible();
    await expect(groups(page).nth(1)).not.toHaveAttribute('open');
  });

  test(`${viewport.name} exposes a denied automatic review in the closed group while its detail card stays closed by default`, async ({
    page,
  }) => {
    await startScenario(page, '[auto-review-denied] [auto-review-slow] 检查自动审核');
    await page.setViewportSize(viewport);
    const group = groups(page).first();
    const review = group.locator('details.auto-review-card');
    await expect(group).not.toHaveAttribute('open');
    await expect(review).not.toHaveAttribute('open');
    await expect(header(group)).toContainText('执行中 1');
    await expect(header(group)).toContainText('已拒绝 1');
    await expect(group).not.toHaveAttribute('open');
    await expect(review).not.toHaveAttribute('open');
    await expect(review.locator('.auto-review-rationale')).not.toBeVisible();
    await expect(page.locator('.action-card')).toHaveCount(0);
    await screenshot(page, `groups-review-denied-collapsed-${viewport.name}`);

    await header(group).click();
    await expect(header(review)).toContainText('已拒绝');
    await expect(review).not.toHaveAttribute('open');
    await screenshot(page, `groups-review-card-collapsed-${viewport.name}`);
    await header(review).click();
    await expect(review.locator('.auto-review-rationale')).toContainText(
      '当前请求未授权发布该文件',
    );
    await expect(review.locator('.auto-review-details')).not.toHaveAttribute('open');
    await expect(review.getByRole('button')).toHaveCount(0);
    await screenshot(page, `groups-review-reason-${viewport.name}`);
  });

  test(`${viewport.name} keeps a long automatic review and its group independently collapsible while reading the reason`, async ({
    page,
  }) => {
    await startScenario(page, '[auto-review-denied] [auto-review-long] 检查完整审核原因');
    await page.setViewportSize(viewport);
    const group = groups(page).first();
    const review = group.locator('details.auto-review-card');
    await expect(header(group)).toContainText('已拒绝 1');
    await expect(group).not.toHaveAttribute('open');
    await header(group).click();
    await expect(review).not.toHaveAttribute('open');
    await header(review).click();
    await expect(review.locator('.auto-review-rationale')).toContainText('审核说明 100');
    await pinChild(group, review);
    await screenshot(page, `groups-long-review-pinned-${viewport.name}`);
    await header(review).click();
    await expectAnchor(review, group);
    await expect(group).toHaveAttribute('open', '');
    await header(review).press('Enter');
    await pinChild(group, review);
    await header(group).click();
    await expectAnchor(group);
    await expect(review).toHaveAttribute('open', '');
    await expect(review.locator('.auto-review-rationale')).not.toBeVisible();
    await screenshot(page, `groups-long-review-collapsed-${viewport.name}`);
  });
}

test('a wrapped group summary reserves its measured height for the sticky child after viewport resizing', async ({
  page,
}) => {
  await startScenario(page, '[activity-mixed] 检查窄屏多状态摘要');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await page.setViewportSize({ width: 1280, height: 900 });
  const group = groups(page).first();
  await expect(header(group)).toContainText('6 项活动');
  for (const status of ['已拒绝 1', '审核超时 1', '已中止 1', '已完成 3'])
    await expect(header(group)).toContainText(status);
  await header(group).click();
  const command = group.locator('.activity-group-items > details.activity').first();
  await header(command).click();
  await pinChild(group, command);
  const wideHeight = (await header(group).boundingBox())!.height;
  await page.setViewportSize({ width: 320, height: 844 });
  await expect
    .poll(async () => (await header(group).boundingBox())!.height)
    .toBeGreaterThan(wideHeight);
  await pinChild(group, command);
  await screenshot(page, 'groups-mixed-status-wrapped-mobile');
  await header(command).click();
  await expectAnchor(command, group);
  await header(command).press('Enter');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(async () => (await header(group).boundingBox())!.height).toBe(wideHeight);
  await pinChild(group, command);
  await screenshot(page, 'groups-mixed-status-resized-desktop');
});

for (const expanded of [true, false]) {
  test(`a streaming group preserves its manually ${expanded ? 'expanded' : 'collapsed'} state when a second activity arrives`, async ({
    page,
  }) => {
    await startScenario(page, '[activity-stream] 检查流式活动分组');
    const group = groups(page).first();
    const command = childActivities(group).first();
    await expect(header(group)).toContainText('1 项活动');
    await header(group).click();
    await header(command).click();
    await expect(command).toHaveAttribute('open', '');
    const originalGroup = (await group.elementHandle())!;
    const originalCommand = (await command.elementHandle())!;
    await expect(command.locator('.tool-output')).toContainText('stream-update-1');
    if (!expanded) await header(group).click();
    await expect(command.locator('.tool-output')).toContainText('stream-update-2');
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await expect(header(group)).toContainText('2 项活动');
    if (expanded) await expect(group).toHaveAttribute('open', '');
    else await expect(group).not.toHaveAttribute('open');
    expect(await originalGroup.evaluate((element) => element.isConnected)).toBe(true);
    expect(await originalCommand.evaluate((element) => element.isConnected)).toBe(true);
    await expect(command).toHaveAttribute('open', '');
    await expect(childActivities(group).nth(1)).not.toHaveAttribute('open');
    await expect(groups(page).nth(1)).not.toHaveAttribute('open');
  });
}

test('user and assistant messages split groups and later turns never reuse an earlier group', async ({
  page,
}) => {
  await startScenario(page, '[activity-stream] 检查消息边界');
  const firstGroup = (await groups(page).first().elementHandle())!;
  await page.getByRole('textbox', { name: '追加要求', exact: true }).fill('请保留这条追加要求');
  await page.getByRole('button', { name: '追加要求', exact: true }).click();
  await expect(page.locator('.user-text').nth(1)).toHaveText('请保留这条追加要求');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  await expect(groups(page)).toHaveCount(3);
  const firstTurn = page.locator('.turn').first();
  expect(
    await firstTurn.evaluate((element) =>
      [...element.children].flatMap((child) =>
        child.matches('.activity-group')
          ? [`activities:${child.querySelectorAll('.activity-group-items > details').length}`]
          : child.matches('.user-message')
            ? ['user']
            : child.matches('.assistant-message')
              ? ['assistant']
              : [],
      ),
    ),
  ).toEqual([
    'user',
    'assistant',
    'activities:1',
    'user',
    'activities:1',
    'assistant',
    'activities:2',
    'assistant',
  ]);
  await expect(firstTurn.locator('.user-message')).toHaveCount(2);
  await expect(firstTurn.locator('.assistant-message')).toHaveCount(3);
  await sendTask(page, '[activity-collapse] 检查下一轮');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(page.locator('.turn')).toHaveCount(2);
  await expect(firstTurn.locator('.activity-group')).toHaveCount(3);
  await expect(page.locator('.turn').last().locator('.activity-group')).toHaveCount(2);
  await expect(groups(page)).toHaveCount(5);
  expect(await firstGroup.evaluate((element) => element.isConnected)).toBe(true);
});
