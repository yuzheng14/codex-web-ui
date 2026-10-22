import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Operation, ThreadView } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, testOrigin, openSidebarSettings } from './helpers';

declare global {
  interface Window {
    notificationTest: {
      permission: NotificationPermission;
      requested: number;
      fail: boolean;
      shown: { title: string; options: NotificationOptions; click: () => void }[];
    };
  }
}
const evidence = join(tmpdir(), 'codex-issue-25-evidence');
const dialog = (page: Page) => page.getByRole('dialog', { name: '工作完成通知' });
async function openNotificationSettings(page: Page) {
  await openSidebarSettings(page);
  await page.getByRole('button', { name: /工作完成通知/ }).click();
}
const toggle = (page: Page) => page.getByRole('switch', { name: '浏览器通知' });
const captured = (page: Page) =>
  page.evaluate(() =>
    window.notificationTest.shown.map(({ title, options }) => ({ title, options })),
  );

async function mockNotifications(page: Page, permission: NotificationPermission = 'default') {
  await page.addInitScript((permission) => {
    const state: Window['notificationTest'] = {
      permission:
        (sessionStorage.getItem('notification-test-permission') as NotificationPermission | null) ??
        permission,
      requested: 0,
      shown: [],
      fail: false,
    };
    window.notificationTest = state;
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: class {
        static get permission() {
          return state.permission;
        }
        static async requestPermission() {
          state.requested++;
          state.permission = 'granted';
          sessionStorage.setItem('notification-test-permission', state.permission);
          return state.permission;
        }
        onclick?: () => void;
        onerror?: () => void;
        close() {}
        constructor(title: string, options: NotificationOptions = {}) {
          if (state.fail) throw new Error('Notifications unavailable');
          state.shown.push({ title, options, click: () => this.onclick?.() });
        }
      },
    });
  }, permission);
}

async function submit(request: APIRequestContext, path: string, data: object = {}) {
  const response = await request.post(path, {
    headers: { Origin: testOrigin },
    data: { clientOperationId: randomUUID(), ...data },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Operation;
}
async function create(request: APIRequestContext, project = 'fixture', title = '通知验收会话') {
  const created = await submit(request, `/api/projects/${project}/threads`);
  const { threadId } = created.result as { threadId: string };
  await submit(request, `/api/threads/${threadId}/rename`, { name: title });
  return threadId;
}
async function start(request: APIRequestContext, id: string, text = '检查完成通知') {
  const operation = await submit(request, `/api/threads/${id}/turns`, {
    text: `${text} [title-fail]`,
  });
  return (operation.result as { turnId: string }).turnId;
}
async function history(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
}
async function waitStatus(request: APIRequestContext, id: string, status: string) {
  await expect.poll(async () => (await history(request, id)).turns.at(-1)?.status).toBe(status);
}
async function open(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
}
async function enable(page: Page) {
  await openNotificationSettings(page);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
}

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
});
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('asks only after a click, shows guidance, and opens the notified project and conversation', async ({
  page,
  request,
}) => {
  await mockNotifications(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  await openNotificationSettings(page);
  await expect(dialog(page)).toContainText('尚未授权 · 未开启');
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(0);
  await page.screenshot({ path: join(evidence, 'notifications-off.png') });
  await toggle(page).click();
  await expect(dialog(page)).toContainText('已授权 · 已开启');
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(1);
  await page.getByRole('button', { name: '发送测试通知' }).click();
  await expect.poll(() => captured(page)).toHaveLength(1);
  await page.evaluate(() => {
    window.notificationTest.shown = [];
  });
  await page.getByText('如何让本站保持活跃', { exact: true }).click();
  await page.screenshot({ path: join(evidence, 'notifications-on-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(evidence, 'notifications-on-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '关闭通知设置' }).click();

  const id = await create(request, 'fixture-other', '跨项目任务结果');
  await start(request, id);
  await expect
    .poll(() => captured(page))
    .toMatchObject([{ title: 'Agent 已完成', options: { body: '另一个项目 · 跨项目任务结果' } }]);
  await page.evaluate(() => window.notificationTest.shown[0]!.click());
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('codex-web.project')))
    .toBe('fixture-other');
  await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
});

test('distinguishes failure and interruption, with no notification from reload, rename or history', async ({
  page,
  request,
}) => {
  await mockNotifications(page);
  await open(page);
  await enable(page);
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  const id = await create(request);
  await start(request, id, '[codex-retry-fail]');
  await expect.poll(() => captured(page)).toMatchObject([{ title: 'Agent 执行失败' }]);
  const turnId = await start(request, id, '[approval] 等待中断');
  await waitStatus(request, id, 'waitingApproval');
  await submit(request, `/api/threads/${id}/interrupt`, { expectedTurnId: turnId });
  await expect
    .poll(() => captured(page))
    .toMatchObject([{ title: 'Agent 执行失败' }, { title: 'Agent 已中断' }]);
  await submit(request, `/api/threads/${id}/rename`, { name: '重命名不重复通知' });
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await expect(page.locator(`[data-thread-id="${id}"]`)).toContainText('重命名不重复通知');
  expect(await captured(page)).toHaveLength(2);
  await page.reload();
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(page.locator(`[data-thread-id="${id}"]`)).toBeVisible();
  expect(await captured(page)).toHaveLength(0);
  await openNotificationSettings(page);
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(0);
});

test('atomically deduplicates simultaneous tabs and shares the notification preference', async ({
  page,
  context,
  request,
}) => {
  await mockNotifications(page);
  await open(page);
  await enable(page);
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  const other = await context.newPage();
  await mockNotifications(other, 'granted');
  await other.goto('/');
  await expect(other.locator('.connection-badge')).toHaveText('实时连接正常');
  const id = await create(request);
  await start(request, id);
  await waitStatus(request, id, 'completed');
  await expect
    .poll(async () => (await captured(page)).length + (await captured(other)).length)
    .toBe(1);
  await openNotificationSettings(other);
  await expect(toggle(other)).toHaveAttribute('aria-checked', 'true');
  await toggle(other).click();
  await openNotificationSettings(page);
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  await start(request, id);
  await waitStatus(request, id, 'completed');
  expect((await captured(page)).length + (await captured(other)).length).toBe(1);
});

test('recovers results and unread markers after freeze/resume lifecycle events without replaying notifications', async ({
  page,
  request,
}) => {
  await mockNotifications(page);
  await open(page);
  await enable(page);
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  const id = await create(request);
  await start(request, id, '[approval] 页面休眠验收');
  await waitStatus(request, id, 'waitingApproval');
  // Headless Chromium keeps pages visible and does not enter the frozen lifecycle state.
  // Dispatch its lifecycle events explicitly; socket closure, server work and recovery are real.
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await expect(page.locator('.connection-badge')).not.toHaveText('实时连接正常');
  const action = (await history(request, id)).actions.find(
    (action) => action.status === 'pending',
  )!;
  await submit(request, `/api/actions/${action.actionId}/resolve`, {
    resolution: { decision: action.options[0]!.id },
  });
  await waitStatus(request, id, 'completed');
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(
    page
      .locator(`[data-thread-id="${id}"]`)
      .locator('..')
      .getByLabel('已完成 · 未读', { exact: true }),
  ).toBeVisible();
  expect(await captured(page)).toHaveLength(0);
  await start(request, id);
  await expect.poll(() => captured(page)).toMatchObject([{ title: 'Agent 已完成' }]);
});

test('denied and unsupported browsers keep in-page results usable', async ({ page, request }) => {
  await mockNotifications(page, 'denied');
  await open(page);
  await openNotificationSettings(page);
  await expect(dialog(page)).toContainText('已被浏览器阻止');
  await expect(toggle(page)).toBeDisabled();
  const id = await create(request);
  await start(request, id);
  await waitStatus(request, id, 'completed');
  expect(await captured(page)).toHaveLength(0);
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(0);
  await page.evaluate(() => {
    Reflect.deleteProperty(window, 'Notification');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(dialog(page)).toContainText('当前浏览器不支持');
  await expect(toggle(page)).toBeDisabled();
  await page.screenshot({ path: join(evidence, 'notifications-unsupported.png') });
  await page.getByRole('button', { name: '关闭通知设置' }).click();
  await expect(
    page
      .locator(`[data-thread-id="${id}"]`)
      .locator('..')
      .getByLabel('已完成 · 未读', { exact: true }),
  ).toBeVisible();
});

test('fails safely when durable deduplication storage is unavailable', async ({
  page,
  request,
}) => {
  await mockNotifications(page);
  await page.addInitScript(() => {
    Object.defineProperty(indexedDB, 'open', {
      value: () => {
        throw new Error('Storage unavailable');
      },
    });
  });
  await open(page);
  await enable(page);
  const id = await create(request);
  await start(request, id);
  await waitStatus(request, id, 'completed');
  await expect(dialog(page).getByRole('alert')).toContainText('去重记录');
  expect(await captured(page)).toHaveLength(0);
});
