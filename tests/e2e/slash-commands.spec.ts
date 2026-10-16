import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';
import type {
  Operation,
  ServerMessage,
  SystemInfo,
  ThreadPage,
  ThreadView,
} from '../../src/shared/types';
import {
  compatibilityDialog,
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  projectGroup,
} from './helpers';

const headers = { Origin: 'http://127.0.0.1:8788' };
const input = (page: Page) => page.getByRole('textbox', { name: /^(任务内容|追加要求)$/ });
const menu = (page: Page) => page.getByRole('listbox', { name: 'Slash 命令', exact: true });
const option = (page: Page, command: string) =>
  menu(page).getByRole('option', { name: new RegExp(`^/${command}\\b`) });
const feedback = (page: Page) => page.locator('.slash-feedback');
const execute = (page: Page) => page.getByRole('button', { name: '执行命令', exact: true });
const selected = (page: Page, projectId = 'fixture') =>
  page.evaluate((id) => localStorage.getItem(`codex-web.selected:${id}`), projectId);
const isMessage = (request: Request) =>
  request.method() === 'POST' && /\/api\/threads\/[^/]+\/(turns|steer)$/.test(request.url());
function posts(page: Page) {
  const requests: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') requests.push(request);
  });
  return requests;
}
async function open(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
}
async function newThread(page: Page) {
  await open(page);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  return (await selected(page))!;
}
async function readThread(request: APIRequestContext, id: string): Promise<ThreadView> {
  const response = await request.get(`/api/threads/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ThreadView;
}
async function finishTurn(page: Page, text: string) {
  await input(page).fill(text);
  await input(page).press('Enter');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
}
async function flushKeyboardEvents(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test.afterEach(async ({ request }) => {
  for (const projectId of ['fixture', 'fixture-other']) {
    const response = await request.get(`/api/threads?projectId=${projectId}`);
    if (!response.ok()) continue;
    const threads = (await response.json()) as ThreadPage;
    for (const thread of threads.data) {
      const turn = thread.turns.findLast((entry) =>
        ['running', 'waitingApproval', 'waitingInput'].includes(entry.status),
      );
      if (turn)
        await request.post(`/api/threads/${thread.id}/interrupt`, {
          headers,
          data: { clientOperationId: randomUUID(), expectedTurnId: turn.id },
        });
    }
  }
});

test('slash suggestions expose commands, filter by name and description, and execute with the keyboard', async ({
  page,
}) => {
  await newThread(page);
  const outgoing = posts(page);
  await input(page).fill('/');
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('option')).toHaveCount(6);
  for (const command of ['help', 'new', 'fork', 'resume', 'stop', 'status']) {
    await expect(option(page, command)).toBeVisible();
    await expect(option(page, command)).toContainText('无需参数');
  }
  await expect(option(page, 'help')).toHaveAttribute('aria-selected', 'true');
  await input(page).press('ArrowDown');
  await expect(option(page, 'new')).toHaveAttribute('aria-selected', 'true');
  await expect(option(page, 'help')).toHaveAttribute('aria-selected', 'false');
  await input(page).press('ArrowUp');
  await expect(option(page, 'help')).toHaveAttribute('aria-selected', 'true');
  await input(page).fill('/新建');
  await expect(menu(page).getByRole('option')).toHaveCount(1);
  await expect(option(page, 'new')).toBeVisible();
  await input(page).fill('/he');
  await expect(menu(page).getByRole('option')).toHaveCount(1);
  await expect(option(page, 'help')).toBeVisible();
  await input(page).press('Enter');
  await expect(feedback(page)).toHaveAttribute('role', 'status');
  for (const command of ['help', 'new', 'fork', 'resume', 'stop', 'status'])
    await expect(feedback(page)).toContainText(`/${command}`);
  await expect(input(page)).toHaveValue('');
  await expect(menu(page)).toHaveCount(0);
  expect(outgoing).toHaveLength(0);
});

test('Escape never turns a command into a message; unknown names and extra arguments retain the draft', async ({
  page,
}) => {
  await newThread(page);
  const outgoing = posts(page);
  await input(page).fill('/status');
  await input(page).press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(input(page)).toHaveValue('/status');
  await input(page).press('Enter');
  await expect(feedback(page)).toHaveAttribute('role', 'status');
  await expect(input(page)).toHaveValue('');
  for (const command of ['/not-a-command', '/new unexpected']) {
    await input(page).fill(command);
    await execute(page).click();
    await expect(feedback(page)).toHaveAttribute('role', 'alert');
    await expect(input(page)).toHaveValue(command);
  }
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  await input(page).fill('//this is literal text');
  await expect(menu(page)).toHaveCount(0);
  const sent = page.waitForRequest(isMessage);
  await input(page).press('Enter');
  expect((await sent).postDataJSON().text).toBe('/this is literal text');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  expect(outgoing.filter(isMessage)).toHaveLength(1);
});

test('Shift+Enter and Chinese composition preserve slash drafts without executing a command', async ({
  page,
}) => {
  await newThread(page);
  const outgoing = posts(page);
  await input(page).fill('/new');
  await input(page).press('Shift+Enter');
  await expect(input(page)).toHaveValue('/new\n');
  await input(page).fill('/new');
  await input(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await input(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await input(page).dispatchEvent('compositionstart');
  await input(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: false });
  await input(page).evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '新建' }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  });
  await flushKeyboardEvents(page);
  await expect(input(page)).toHaveValue('/new');
  expect(outgoing).toHaveLength(0);
  const creation = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/api/projects/fixture/threads'),
  );
  await input(page).press('Enter');
  await creation;
  await expect(input(page)).toHaveValue('');
  expect(outgoing.filter(isMessage)).toHaveLength(0);
});

test('mouse and touch can execute menu entries without submitting user messages', async ({
  page,
  browser,
}, testInfo) => {
  await newThread(page);
  const outgoing = posts(page);
  await input(page).fill('/');
  await option(page, 'status').click();
  await expect(feedback(page)).toHaveAttribute('role', 'status');
  await expect(input(page)).toHaveValue('');
  expect(outgoing).toHaveLength(0);
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:8788',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const mobile = await context.newPage();
    const mobileOutgoing = posts(mobile);
    await mobile.goto('/');
    await expect(mobile.locator('.connection-badge')).toHaveText('实时连接正常');
    // The overview socket can connect before the initial project selects its draft.
    await expect(mobile.locator('.composer-target')).toHaveText('测试项目');
    await input(mobile).fill('/');
    await expect(option(mobile, 'help')).toBeInViewport();
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const screenshot = testInfo.outputPath('slash-commands-mobile.png');
    await mobile.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    await testInfo.attach('slash-commands-mobile', { path: screenshot, contentType: 'image/png' });
    await option(mobile, 'help').tap();
    await expect(feedback(mobile)).toHaveAttribute('role', 'status');
    await expect(feedback(mobile)).toContainText('/new');
    await expect(input(mobile)).toHaveValue('');
    await input(mobile).fill('/');
    const bounds = (await menu(mobile).boundingBox())!;
    const cdp = await context.newCDPSession(mobile);
    // Native touch movement must scroll the unfiltered list, without a command firing on drag.
    for (let swipe = 0; swipe < 3; swipe++) {
      const x = bounds.x + bounds.width / 2;
      const startY = bounds.y + bounds.height - 20;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y: startY }],
      });
      for (let step = 1; step <= 6; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: startY - ((bounds.height - 40) * step) / 6 }],
        });
        await flushKeyboardEvents(mobile);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await expect
      .poll(() => menu(mobile).evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(option(mobile, 'status')).toBeInViewport();
    await expect(input(mobile)).toHaveValue('/');
    await option(mobile, 'status').tap();
    await expect(feedback(mobile)).toHaveAttribute('role', 'status');
    await expect(mobile.getByRole('region', { name: '状态诊断详情' })).toBeVisible();
    await expect(input(mobile)).toHaveValue('');
    expect(mobileOutgoing).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test('/new creates a conversation in the selected project from its overview', async ({
  page,
  request,
}) => {
  await open(page);
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  const outgoing = posts(page);
  await input(page).fill('/new');
  await expect(execute(page)).toBeEnabled();
  const creation = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/api/projects/fixture-other/threads'),
  );
  await execute(page).click();
  expect((await creation).postDataJSON().clientOperationId).toBeTruthy();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  const id = (await selected(page, 'fixture-other'))!;
  expect((await readThread(request, id)).projectId).toBe('fixture-other');
  await expect(input(page)).toHaveValue('');
  expect(outgoing.filter(isMessage)).toHaveLength(0);
});

test('a delayed /new receipt cannot replace another project or overwrite a newer draft', async ({
  page,
  request,
}) => {
  let withholdCreate = false;
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (
        withholdCreate &&
        message.type === 'event' &&
        message.kind === 'operation' &&
        (message.payload as Operation).kind === 'thread.create'
      )
        return;
      socket.send(raw);
    });
  });
  const source = await newThread(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let capture!: (id: string) => void;
  const created = new Promise<string>((resolve) => {
    capture = resolve;
  });
  withholdCreate = true;
  await page.route('**/api/projects/fixture/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    const operation = (await response.json()) as Operation;
    capture((operation.result as { threadId: string }).threadId);
    await gate;
    await route.fulfill({ response });
  });
  await input(page).fill('/new');
  await input(page).press('Enter');
  const createdId = await created;
  await input(page).fill('命令发起后新写的草稿');
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  await input(page).fill('另一项目独立草稿');
  release();
  await expect(createThreadButton(page)).toBeEnabled();
  await expect(page.locator(`[data-thread-id="${createdId}"]`)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('codex-web.project'))).toBe(
    'fixture-other',
  );
  await expect(input(page)).toHaveValue('另一项目独立草稿');
  await expect(feedback(page)).toHaveCount(0);
  expect((await readThread(request, createdId)).projectId).toBe('fixture');
  await page.locator(`[data-thread-id="${source}"]`).click();
  await expect(input(page)).toHaveValue('命令发起后新写的草稿');
  expect(await selected(page)).toBe(source);
});

test('/fork copies the selected history without creating a prompt in either conversation', async ({
  page,
  request,
}) => {
  const source = await newThread(page);
  await finishTurn(page, '斜杠命令分支的原始历史');
  const outgoing = posts(page);
  await input(page).fill('/fork');
  const forked = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith(`/api/threads/${source}/fork`),
  );
  await input(page).press('Enter');
  expect((await forked).postDataJSON().clientOperationId).toBeTruthy();
  await expect(page.getByRole('button', { name: '返回原会话', exact: true })).toBeVisible();
  const fork = (await selected(page))!;
  expect(fork).not.toBe(source);
  const forkThread = await readThread(request, fork);
  expect(forkThread.forkedFromId).toBe(source);
  expect(forkThread.turns).toHaveLength(1);
  expect((await readThread(request, source)).turns).toHaveLength(1);
  await expect(input(page)).toHaveValue('');
  expect(outgoing.filter(isMessage)).toHaveLength(0);
});

test('/resume retries only the selected external conversation after its owner releases it', async ({
  page,
  request,
}) => {
  const { externalThreadId: id } = await controlRuntime(request, { external: 'occupied' });
  await page.addInitScript((id) => {
    localStorage.setItem('codex-web.project', 'fixture');
    localStorage.setItem('codex-web.selected:fixture', id!);
  }, id);
  await open(page);
  await expect(page.locator('.session-resume-notice')).toContainText('此会话正被其他进程使用');
  await controlRuntime(request, { releaseThreadId: id });
  const outgoing = posts(page);
  await input(page).fill('/resume');
  await expect(execute(page)).toBeEnabled();
  const resumed = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith(`/api/threads/${id}/resume`),
  );
  await input(page).press('Enter');
  expect((await resumed).postDataJSON().clientOperationId).toBeTruthy();
  await expect(page.locator('.session-resume-notice')).toHaveCount(0);
  await expect(input(page)).toHaveValue('');
  expect(await selected(page)).toBe(id);
  expect((await readThread(request, id!)).managed).toBe(true);
  expect(outgoing.filter(isMessage)).toHaveLength(0);
  expect(outgoing.filter((request) => request.url().endsWith('/resume'))).toHaveLength(1);
});

test('/stop uses the current turn ID and remains available when compatibility needs confirmation', async ({
  page,
  request,
}) => {
  const id = await newThread(page);
  await input(page).fill('[approval] 斜杠停止目标');
  await input(page).press('Enter');
  await expect(page.locator('.action-card')).toBeVisible();
  const turnId = (await readThread(request, id)).turns.at(-1)!.id;
  await controlRuntime(request, { version: 'fixture-slash-stop-unconfirmed' });
  await expect(compatibilityDialog(page)).toBeVisible();
  await compatibilityDialog(page).getByRole('button', { name: '暂不使用', exact: true }).click();
  const outgoing = posts(page);
  await input(page).fill('/stop');
  await expect(execute(page)).toBeEnabled();
  const interrupted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith(`/api/threads/${id}/interrupt`),
  );
  await input(page).press('Enter');
  expect((await interrupted).postDataJSON()).toMatchObject({ expectedTurnId: turnId });
  await expect(page.locator('.turn-heading .status')).toHaveText('已中断');
  await expect(input(page)).toHaveValue('');
  expect(outgoing.filter(isMessage)).toHaveLength(0);
});

test('unavailable commands explain empty history, compatibility, offline and runtime guards while local help still works', async ({
  page,
  context,
  request,
}) => {
  await newThread(page);
  const outgoing = posts(page);
  await input(page).fill('/fork');
  await expect(option(page, 'fork')).toHaveAttribute('aria-disabled', 'true');
  await expect(option(page, 'fork')).toContainText(/历史|首条/);
  await expect(execute(page)).toBeDisabled();
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('/fork');
  await input(page).fill('/stop');
  await expect(option(page, 'stop')).toHaveAttribute('aria-disabled', 'true');
  await expect(option(page, 'stop')).toContainText('没有可中断的任务');
  await controlRuntime(request, { version: 'fixture-slash-unconfirmed' });
  await expect(compatibilityDialog(page)).toBeVisible();
  await compatibilityDialog(page).getByRole('button', { name: '暂不使用', exact: true }).click();
  await input(page).fill('/new');
  await expect(option(page, 'new')).toContainText(/兼容|确认/);
  await expect(execute(page)).toBeDisabled();
  await controlRuntime(request, { unavailable: true });
  await expect(option(page, 'new')).toHaveAttribute('aria-disabled', 'true');
  await expect(execute(page)).toBeDisabled();
  await context.setOffline(true);
  await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('/new');
  await input(page).fill('/help');
  await expect(execute(page)).toBeEnabled();
  await input(page).press('Enter');
  await expect(feedback(page)).toContainText('/status');
  await input(page).fill('/status');
  await expect(execute(page)).toBeEnabled();
  await input(page).press('Enter');
  await expect(feedback(page)).toHaveAttribute('role', 'status');
  await flushKeyboardEvents(page);
  expect(outgoing).toHaveLength(0);
  await context.setOffline(false);
});

test('unauthenticated sessions cannot dispatch slash operations', async ({ page }) => {
  await newThread(page);
  await page.route('**/api/system', async (route) => {
    const response = await route.fetch();
    const system = (await response.json()) as SystemInfo;
    await route.fulfill({ response, json: { ...system, authenticated: false } });
  });
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === 'event' && message.kind === 'runtime')
        message.payload = { ...(message.payload as SystemInfo), authenticated: false };
      socket.send(JSON.stringify(message));
    });
  });
  await page.reload();
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  const outgoing = posts(page);
  await input(page).fill('/new');
  await expect(option(page, 'new')).toHaveAttribute('aria-disabled', 'true');
  await expect(option(page, 'new')).toContainText(/身份|认证|登录|权限/);
  await expect(execute(page)).toBeDisabled();
  await input(page).press('Enter');
  await flushKeyboardEvents(page);
  await expect(input(page)).toHaveValue('/new');
  expect(outgoing).toHaveLength(0);
});

test('command errors and image attachments keep the command draft without sending it as a task', async ({
  page,
}) => {
  const source = await newThread(page);
  await finishTurn(page, '命令失败时保留原会话');
  const outgoing = posts(page);
  await page.route('**/api/threads/*/fork', (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'CODEX_RPC_ERROR', message: '测试命令 Fork 失败' } },
    }),
  );
  await input(page).fill('/fork');
  await input(page).press('Enter');
  await expect(feedback(page)).toHaveAttribute('role', 'alert');
  await expect(feedback(page)).toContainText('核对提交');
  await expect(page.locator('.error-banner.dismissible')).toContainText('测试命令 Fork 失败');
  await expect(input(page)).toHaveValue('/fork');
  expect(await selected(page)).toBe(source);
  await input(page).fill('/new');
  await input(page).evaluate((element) => {
    const data = new DataTransfer();
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(png), (value) => value.charCodeAt(0));
    data.items.add(new File([bytes], 'command-image.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator('.composer-images img')).toHaveCount(1);
  await input(page).press('Enter');
  await expect(feedback(page)).toHaveAttribute('role', 'alert');
  await expect(feedback(page)).toContainText(/图片/);
  await expect(input(page)).toHaveValue('/new');
  await expect(page.locator('.composer-images img')).toHaveCount(1);
  expect(outgoing.filter(isMessage)).toHaveLength(0);
  expect(
    outgoing.filter((request) => request.url().endsWith('/api/projects/fixture/threads')),
  ).toHaveLength(0);
});

test('switching conversations resets the menu selection while keeping each draft with its conversation', async ({
  page,
}) => {
  const first = await newThread(page);
  await input(page).fill('/');
  await input(page).press('ArrowDown');
  await expect(option(page, 'new')).toHaveAttribute('aria-selected', 'true');
  await createThreadButton(page).click();
  await expect(input(page)).toHaveValue('');
  await expect(menu(page)).toHaveCount(0);
  await input(page).fill('/');
  await expect(option(page, 'help')).toHaveAttribute('aria-selected', 'true');
  await input(page).fill('另一个会话的普通草稿');
  const second = (await selected(page))!;
  await page.locator(`[data-thread-id="${first}"]`).click();
  await expect(input(page)).toHaveValue('/');
  await expect(menu(page)).toHaveCount(0);
  await input(page).focus();
  await expect(option(page, 'help')).toHaveAttribute('aria-selected', 'true');
  await page.locator(`[data-thread-id="${second}"]`).click();
  await expect(input(page)).toHaveValue('另一个会话的普通草稿');
  await expect(menu(page)).toHaveCount(0);
});
