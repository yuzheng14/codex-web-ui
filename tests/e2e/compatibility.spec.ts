import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { SystemInfo } from '../../src/shared/types';
import {
  compatibilityDialog,
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  expectThreadReady,
} from './helpers';

const headers = { Origin: 'http://127.0.0.1:8788' };
async function system(request: APIRequestContext): Promise<SystemInfo> {
  const response = await request.get('/api/system');
  expect(response.ok()).toBe(true);
  return (await response.json()) as SystemInfo;
}
function confirmation(current: SystemInfo) {
  return {
    clientOperationId: randomUUID(),
    codexEpoch: current.codexEpoch,
    codexVersion: current.codexVersion,
    verifiedVersion: current.verifiedVersion,
    confirm: true,
  };
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('an unverified version requires explicit confirmation while cancel preserves diagnostics', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(compatibilityDialog(page)).toBeVisible();
  await page.screenshot({ path: '/tmp/codex-web-compatibility-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    compatibilityDialog(page).getByRole('button', { name: '确认继续', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: '/tmp/codex-web-compatibility-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(createThreadButton(page)).toBeDisabled();
  expect((await system(request)).compatibilityConfirmation).toBe('required');
  const blocked = await request.post('/api/projects/fixture/threads', {
    headers,
    data: { clientOperationId: randomUUID() },
  });
  expect(blocked.status()).toBe(409);
  expect(await blocked.json()).toMatchObject({
    error: { code: 'COMPATIBILITY_CONFIRMATION_REQUIRED' },
  });

  await compatibilityDialog(page).getByRole('button', { name: '暂不使用', exact: true }).click();
  await expect(compatibilityDialog(page)).not.toBeVisible();
  await page.locator('details.diagnostics > summary').click();
  await expect(
    page.locator('details.diagnostics').getByText('fixture-unverified-1', { exact: true }),
  ).toBeVisible();
  expect((await system(request)).compatibilityConfirmation).toBe('required');
  await page.locator('details.diagnostics > summary').click();
  await page.getByRole('button', { name: '查看兼容性提示', exact: true }).click();
  await confirmCompatibility(page);
  expect((await system(request)).compatibilityConfirmation).toBe('confirmed');
  await createThreadButton(page).click();
  await expectThreadReady(page);
  await page.getByRole('textbox', { name: '任务内容' }).fill('已明确确认兼容性后执行');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
});

test('confirmation is shared by tabs and survives reload within the same gateway runtime', async ({
  page,
  context,
  request,
}) => {
  await page.goto('/');
  await expect(compatibilityDialog(page)).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await expect(compatibilityDialog(second)).toBeVisible();
  const before = await system(request);
  await confirmCompatibility(page);
  // The already-open second tab receives the confirmed state through its real WebSocket.
  await expect(compatibilityDialog(second)).not.toBeVisible();
  await expect(createThreadButton(second)).toBeEnabled();
  await page.reload();
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(compatibilityDialog(page)).not.toBeVisible();
  await expect(createThreadButton(page)).toBeEnabled();
  const after = await system(request);
  expect(after.codexEpoch).toBe(before.codexEpoch);
  expect(after.compatibilityConfirmation).toBe('confirmed');
});

test('version or process epoch changes revoke confirmation and reject old fingerprints', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const first = await system(request);
  const changed = await controlRuntime(request, { version: 'fixture-unverified-2' });
  expect(changed.codexEpoch).toBe(first.codexEpoch);
  expect(changed.compatibilityConfirmation).toBe('required');
  await expect(compatibilityDialog(page)).toBeVisible();
  const staleVersion = await request.post('/api/system/compatibility/confirm', {
    headers,
    data: confirmation(first),
  });
  expect(staleVersion.status()).toBe(409);
  expect(await staleVersion.json()).toMatchObject({ error: { code: 'COMPATIBILITY_CHANGED' } });
  await confirmCompatibility(page);
  const second = await system(request);
  const restarted = await controlRuntime(request, { reset: true, version: second.codexVersion! });
  expect(restarted.codexEpoch).not.toBe(second.codexEpoch);
  expect(restarted.codexVersion).toBe(second.codexVersion);
  expect(restarted.compatibilityConfirmation).toBe('required');
  await expect(compatibilityDialog(page)).toBeVisible();
  const staleEpoch = await request.post('/api/system/compatibility/confirm', {
    headers,
    data: confirmation(second),
  });
  expect(staleEpoch.status()).toBe(409);
  expect(await staleEpoch.json()).toMatchObject({ error: { code: 'COMPATIBILITY_CHANGED' } });
  await confirmCompatibility(page);
  expect((await system(request)).compatibilityConfirmation).toBe('confirmed');
});

test('an unavailable runtime cannot be bypassed by a compatibility confirmation', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(compatibilityDialog(page)).toBeVisible();
  const unavailable = await controlRuntime(request, { unavailable: true });
  expect(unavailable.ready).toBe(false);
  await expect(
    compatibilityDialog(page).getByText('Codex 当前不可用，无法确认继续。', { exact: false }),
  ).toBeVisible();
  await expect(
    compatibilityDialog(page).getByRole('button', { name: '确认继续', exact: true }),
  ).toHaveCount(0);
  const rejected = await request.post('/api/system/compatibility/confirm', {
    headers,
    data: confirmation(unavailable),
  });
  expect(rejected.status()).toBe(503);
  expect(await rejected.json()).toMatchObject({ error: { code: 'CODEX_UNAVAILABLE' } });
  await compatibilityDialog(page).getByRole('button', { name: '暂不使用', exact: true }).click();
  await expect(createThreadButton(page)).toBeDisabled();
  expect((await system(request)).compatibilityConfirmation).not.toBe('confirmed');
});

test('an existing turn can still be interrupted when a version change requires new confirmation', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expectThreadReady(page);
  await page.getByRole('textbox', { name: '任务内容' }).fill('[approval] 等待决定时模拟兼容性变更');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  await controlRuntime(request, { version: 'fixture-unverified-interrupt' });
  await expect(compatibilityDialog(page)).toBeVisible();
  await compatibilityDialog(page).getByRole('button', { name: '暂不使用', exact: true }).click();
  await expect(page.getByRole('button', { name: '追加要求', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '中断', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已中断');
  expect((await system(request)).compatibilityConfirmation).toBe('required');
});

test('an unsent confirmation can be explicitly authorized again after refreshing runtime without starting work', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(compatibilityDialog(page)).toBeVisible();
  const attempts: string[] = [];
  let taskSubmissions = 0;
  let systemReads = 0;
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'GET' && outgoing.url().endsWith('/api/system')) systemReads++;
    if (
      outgoing.method() === 'POST' &&
      /\/api\/(?:projects\/[^/]+\/threads|threads\/[^/]+\/turns)$/.test(outgoing.url())
    )
      taskSubmissions++;
  });
  await page.route('**/api/system/compatibility/confirm', async (route) => {
    attempts.push(
      (route.request().postDataJSON() as { clientOperationId: string }).clientOperationId,
    );
    if (attempts.length === 1)
      await route.abort('failed'); // Never reaches the service.
    else await route.continue();
  });
  const missing = page.waitForResponse(
    (response) => /\/api\/operations\/[^/]+$/.test(response.url()) && response.status() === 404,
  );
  await compatibilityDialog(page).getByRole('button', { name: '确认继续', exact: true }).click();
  await missing;
  expect((await system(request)).compatibilityConfirmation).toBe('required');
  await expect(compatibilityDialog(page)).toBeVisible();
  const retry = compatibilityDialog(page).getByRole('button', { name: '重新确认', exact: true });
  await expect(retry).toBeEnabled();
  expect(attempts).toHaveLength(1);
  const readsBeforeRetry = systemReads;
  await retry.click();
  await expect(compatibilityDialog(page)).not.toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).not.toBe(attempts[0]);
  expect(systemReads).toBeGreaterThan(readsBeforeRetry);
  expect(taskSubmissions).toBe(0);
  expect((await system(request)).compatibilityConfirmation).toBe('confirmed');
  const threads = await request.get('/api/threads?projectId=fixture');
  expect(await threads.json()).toMatchObject({ data: [] });
});
