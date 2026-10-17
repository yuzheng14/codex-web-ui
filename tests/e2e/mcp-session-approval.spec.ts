import { expect, test, type Page, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PendingAction, ThreadView } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  createThreadButton,
  expectThreadReady,
  testOrigin,
} from './helpers';

const headers = { Origin: testOrigin };
const evidence = join(tmpdir(), 'codex-issue-99-evidence');
const isResolution = (request: Request) =>
  request.method() === 'POST' && /\/api\/actions\/[^/]+\/resolve$/.test(request.url());

async function pendingTask(page: Page, kind: string) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expectThreadReady(page);
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill(`[${kind}] 上传本次截图附件`);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  const threadId = (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
  const thread = (await (await page.request.get(`/api/threads/${threadId}`)).json()) as ThreadView;
  return { threadId, action: thread.actions.find((action) => action.status === 'pending')! };
}

async function rejectResolution(page: Page, action: PendingAction, resolution: unknown) {
  const response = await page.request.post(`/api/actions/${action.actionId}/resolve`, {
    headers,
    data: { clientOperationId: randomUUID(), resolution },
  });
  expect(response.status()).toBe(400);
  const thread = (await (
    await page.request.get(`/api/threads/${action.threadId}`)
  ).json()) as ThreadView;
  expect(thread.actions.find((entry) => entry.actionId === action.actionId)?.status).toBe(
    'pending',
  );
}

test.beforeAll(() => mkdir(evidence, { recursive: true }));
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} MCP approval retains session choices after reconnect and submits only the chosen scope`, async ({
    page,
    context,
  }) => {
    const outgoing: Request[] = [];
    page.on('request', (request) => {
      if (isResolution(request)) outgoing.push(request);
    });
    const { action } = await pendingTask(
      page,
      viewport.name === 'desktop' ? 'elicitation-session' : 'elicitation-session-array',
    );
    await page.setViewportSize(viewport);
    const card = page.locator('.action-card');
    await page.reload();
    await expect(card.getByRole('button', { name: '本会话允许', exact: true })).toBeVisible();
    await context.setOffline(true);
    await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
    for (const button of await card.getByRole('button').all()) await expect(button).toBeDisabled();
    await context.setOffline(false);
    await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
    expect(outgoing).toHaveLength(0);
    await expect(card).toContainText('新会话需重新确认');
    for (const label of ['允许本次', '本会话允许', '拒绝', '取消'])
      await expect(card.getByRole('button', { name: label, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `${evidence}/session-${viewport.name}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    const session = viewport.name === 'mobile';
    await card
      .getByRole('button', { name: session ? '本会话允许' : '允许本次', exact: true })
      .click();
    await expect(card).not.toBeVisible();
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.postDataJSON().resolution).toEqual(
      session ? { decision: 'accept', persist: 'session' } : { decision: 'accept' },
    );
    expect(action.elicitation?.approval?.allowSession).toBe(true);
  });
}

for (const kind of ['elicitation-approval', 'elicitation-form', 'elicitation-url']) {
  test(`${kind} never offers or accepts an unadvertised session grant`, async ({ page }) => {
    const { action } = await pendingTask(page, kind);
    const card = page.locator('.action-card');
    await expect(card.getByRole('button', { name: '本会话允许', exact: true })).toHaveCount(0);
    await rejectResolution(page, action, { decision: 'accept', persist: 'session' });
    if (kind === 'elicitation-approval') {
      await expect(card.getByRole('button', { name: '允许本次', exact: true })).toBeVisible();
      await page.screenshot({
        path: `${evidence}/once-only.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
    await card.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(card).not.toBeVisible();
  });
}

for (const decision of ['decline', 'cancel']) {
  test(`MCP ${decision} and tampered session answers preserve the protocol boundary`, async ({
    page,
  }) => {
    const { action } = await pendingTask(page, 'elicitation-session');
    for (const resolution of [
      { decision: 'acceptForSession' },
      { decision: 'accept', persist: 'always' },
      { decision: 'accept', _meta: { persist: 'session' } },
      { decision: 'accept', persist: 'session', content: {} },
      { decision, persist: 'session' },
    ])
      await rejectResolution(page, action, resolution);
    const submitted = page.waitForRequest(isResolution);
    await page
      .locator('.action-card')
      .getByRole('button', { name: decision === 'decline' ? '拒绝' : '取消', exact: true })
      .click();
    expect((await submitted).postDataJSON().resolution).toEqual({ decision });
    await expect(page.locator('.action-card')).not.toBeVisible();
    const thread = (await (
      await page.request.get(`/api/threads/${action.threadId}`)
    ).json()) as ThreadView;
    expect(thread.turns.at(-1)?.status).toBe('interrupted');
    expect(thread.turns.at(-1)?.items.some((item) => item.type === 'commandExecution')).toBe(false);
  });
}

test('an interrupted MCP session approval cannot grant permissions', async ({ page }) => {
  const { threadId, action } = await pendingTask(page, 'elicitation-session');
  const interrupted = await page.request.post(`/api/threads/${threadId}/interrupt`, {
    headers,
    data: { clientOperationId: randomUUID(), expectedTurnId: action.turnId },
  });
  expect(interrupted.ok()).toBe(true);
  await expect(page.locator('.action-card')).not.toBeVisible();
  const response = await page.request.post(`/api/actions/${action.actionId}/resolve`, {
    headers,
    data: {
      clientOperationId: randomUUID(),
      resolution: { decision: 'accept', persist: 'session' },
    },
  });
  expect(response.status()).toBe(409);
});
