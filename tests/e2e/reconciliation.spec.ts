import { expect, test, type Page } from '@playwright/test';
import type { Operation, ThreadView } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

const panel = (page: Page) => page.getByRole('region', { name: '状态诊断详情' });
const checkButton = (page: Page) =>
  page.locator('.pending-notice').getByRole('button', { name: '核对提交', exact: true });
const input = (page: Page) => page.getByRole('textbox', { name: '任务内容', exact: true });
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

async function completedThread(page: Page, text = '核对状态回归测试') {
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  await input(page).fill(text);
  const response = page.waitForResponse(
    (entry) => entry.request().method() === 'POST' && entry.url().endsWith('/turns'),
  );
  await send(page).click();
  const operation = (await (await response).json()) as Operation;
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  return operation;
}

test('checking refreshes unknown history even with no saved browser operations', async ({
  page,
}) => {
  const operation = await completedThread(page);
  let stale = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/threads/${operation.target}`, async (route) => {
    const response = await route.fetch();
    if (!stale) await gate;
    await route.fulfill({
      response,
      json: { ...(await response.json()), ...(stale ? { status: 'unknown' } : {}) },
    });
  });
  // Keep the stale HTTP snapshot visible until the explicit history read.
  await page.routeWebSocket('**/ws?overview=1', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'snapshot' && message.kind !== 'thread') socket.send(raw);
    });
  });
  await page.evaluate(() => localStorage.removeItem('codex-web.operations.v1'));
  await page.reload();
  await expect(checkButton(page)).toBeVisible();
  await input(page).fill('核对后继续的草稿');
  await expect(send(page)).toBeDisabled();
  stale = false;
  await checkButton(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toBeFocused();
  await expect(panel(page).getByText('正在核对会话历史和提交回执…')).toBeVisible();
  await expect(
    page.locator('.pending-notice').getByRole('button', { name: '正在核对…' }),
  ).toBeDisabled();
  release();
  await expect(page.locator('.pending-notice')).toHaveCount(0);
  await expect(panel(page).getByText('没有待核对的提交。')).toBeVisible();
  await expect(send(page)).toBeEnabled();
  await expect(input(page)).toHaveValue('核对后继续的草稿');
});

for (const mobile of [false, true]) {
  test(`checking unloaded managed history recovers through Codex and the real gateway (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
  }, testInfo) => {
    const operation = await completedThread(page, '[unload] 已完成后卸载的会话');
    // Let the normal receipt poll remove the finished operation. No HTTP or WebSocket
    // response is mocked: the fixture emits a real notLoaded protocol notification.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('codex-web.operations.v1')))
      .toBe('[]');
    await expect(page.locator('.topbar .status')).toHaveText('状态待核对');
    await expect(checkButton(page)).toBeVisible();
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    await input(page).fill('恢复后继续的草稿');
    await expect(send(page)).toBeDisabled();
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(request.url());
    });
    const response = page.waitForResponse(
      (entry) =>
        entry.request().method() === 'GET' &&
        entry.url().endsWith(`/api/threads/${operation.target}`),
    );
    await checkButton(page).click();
    const received = await response;
    expect(received.ok()).toBe(true);
    const recovered = (await received.json()) as ThreadView;
    expect(recovered).toMatchObject({ id: operation.target, status: 'completed', managed: true });
    expect(recovered.execution).toBeUndefined();
    await expect(panel(page).getByText('没有待核对的提交。')).toBeVisible();
    await expect(page.locator('.pending-notice')).toHaveCount(0);
    await expect(page.locator('.topbar .status')).toHaveText('已完成');
    await expect(send(page)).toBeEnabled();
    await expect(input(page)).toHaveValue('恢复后继续的草稿');
    expect(posts).toHaveLength(0);
    await page.screenshot({
      path: testInfo.outputPath(`recovered-${mobile ? 'mobile' : 'desktop'}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator('.diagnostics > summary').click();
    await send(page).click();
    await expect(page.locator('.turn')).toHaveCount(2);
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    expect(posts).toEqual([expect.stringContaining(`/api/threads/${operation.target}/turns`)]);
  });

  test(`unknown receipt opens manual reconciliation and refreshes its result (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
  }, testInfo) => {
    const operation = await completedThread(page);
    await page.route(`**/api/operations/${operation.clientOperationId}`, async (route) => {
      const response = await route.fetch();
      // An uncertain receipt stays unknown even after human reconciliation.
      await route.fulfill({ response, json: { ...(await response.json()), status: 'unknown' } });
    });
    await page.evaluate((receipt) => {
      localStorage.setItem(
        'codex-web.operations.v1',
        JSON.stringify([
          {
            clientOperationId: receipt.clientOperationId,
            kind: 'send',
            target: receipt.target,
            createdAt: receipt.createdAt,
          },
        ]),
      );
    }, operation);
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    else await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await expect(checkButton(page)).toBeVisible();
    const submissions: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') submissions.push(request.url());
    });
    await input(page).fill('核对期间保留的草稿');
    await checkButton(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('button', { name: '刷新状态' })).toBeEnabled();
    const confirm = panel(page).getByRole('checkbox', { name: '我已核实对应旧运行已经结束' });
    const reconcile = panel(page).getByRole('button', { name: '核对并解除旧占用' });
    await expect(confirm).toBeVisible();
    await expect(confirm).not.toBeChecked();
    await expect(reconcile).toBeDisabled();
    expect(submissions).toHaveLength(0);
    await page.screenshot({
      path: testInfo.outputPath(`reconciliation-${mobile ? 'mobile' : 'desktop'}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await confirm.check();
    await reconcile.click();
    await expect(page.locator('.pending-notice')).toHaveCount(0);
    await expect(panel(page).getByText(/人工核对旧运行结束/)).toBeVisible();
    await expect(panel(page).getByText('提交结果待核对', { exact: true })).toBeVisible();
    await expect(send(page)).toBeEnabled();
    await expect(input(page)).toHaveValue('核对期间保留的草稿');
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toContain(`/api/operations/${operation.clientOperationId}/reconcile`);
    // The native summary still closes and reopens the panel after the banner opened it.
    await page.locator('.diagnostics > summary').click();
    await expect(panel(page)).not.toBeVisible();
    await page.locator('.diagnostics > summary').click();
    await expect(panel(page)).toBeVisible();
  });
}

test('a failed receipt lookup is visible and retry does not resubmit the task', async ({
  page,
}) => {
  await completedThread(page);
  let submissions = 0;
  let uncertainOperationId = '';
  await page.route('**/api/threads/*/turns', async (route) => {
    submissions++;
    uncertainOperationId = route.request().postDataJSON().clientOperationId;
    await route.abort('failed');
  });
  await page.route('**/api/operations/*', (route) => {
    if (!route.request().url().endsWith(`/${uncertainOperationId}`)) return route.continue();
    return route.fulfill({
      status: 503,
      json: { error: { code: 'UNAVAILABLE', message: '核对服务暂时不可用' } },
    });
  });
  await input(page).fill('回执丢失时保留的草稿');
  await send(page).click();
  await checkButton(page).click();
  await expect(panel(page).getByText('无法确认提交：核对服务暂时不可用')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: '刷新状态' })).toBeEnabled();
  await panel(page).getByRole('button', { name: '刷新状态' }).click();
  await expect(panel(page).getByRole('button', { name: '刷新状态' })).toBeEnabled();
  await expect(send(page)).toBeDisabled();
  await expect(input(page)).toHaveValue('回执丢失时保留的草稿');
  expect(submissions).toBe(1);
});
