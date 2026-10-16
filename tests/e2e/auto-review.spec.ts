import { expect, test, type Page, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadPage, ThreadView } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

const evidence = join(tmpdir(), 'codex-auto-review-evidence');
const headers = { Origin: 'http://127.0.0.1:8788' };
const reviewCard = (page: Page) => page.locator('details.auto-review-card');
const reviewGroup = (page: Page) => page.locator('details.activity-group');
const authorizationRequest = (request: Request) =>
  request.method() === 'POST' &&
  (/\/api\/actions\//.test(request.url()) ||
    /approveGuardian|approval|permissions\/grant/i.test(request.url()));
async function startReview(page: Page, prompt: string) {
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(reviewGroup(page)).toBeVisible();
  await expect(reviewGroup(page)).not.toHaveAttribute('open');
  await reviewGroup(page).locator(':scope > summary').click();
  await expect(reviewCard(page)).toBeVisible();
  await expect(reviewCard(page)).not.toHaveAttribute('open');
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}
async function currentThread(page: Page, threadId: string) {
  const response = await page.request.get(`/api/threads/${threadId}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ThreadView;
}
async function screenshot(page: Page, name: string) {
  await reviewCard(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
});
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
test.afterEach(async ({ request }) => {
  const response = await request.get('/api/threads?projectId=fixture');
  if (!response.ok()) return;
  for (const thread of ((await response.json()) as ThreadPage).data) {
    const turn = thread.turns.findLast((entry) =>
      ['running', 'waitingApproval', 'waitingInput'].includes(entry.status),
    );
    if (turn)
      await request.post(`/api/threads/${thread.id}/interrupt`, {
        headers,
        data: { clientOperationId: randomUUID(), expectedTurnId: turn.id },
      });
  }
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} shows the denied automatic review and reason without asking for or sending approval`, async ({
    page,
    context,
  }) => {
    const authorizations: Request[] = [];
    page.on('request', (request) => {
      if (authorizationRequest(request)) authorizations.push(request);
    });
    const threadId = await startReview(
      page,
      '[auto-review-denied] [auto-review-slow] 发布本次截图',
    );
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const card = reviewCard(page);
    await expect(card.locator('.auto-review-status')).toHaveText('审核中');
    await expect(card).not.toHaveAttribute('open');
    await expect(card.locator('.auto-review-details')).not.toHaveAttribute('open');
    await expect(page.locator('.action-card')).toHaveCount(0);
    await expect(card.getByRole('button')).toHaveCount(0);
    await screenshot(page, `auto-review-in-progress-${viewport.name}`);
    await expect(card.locator('.auto-review-status')).toHaveText('已拒绝');
    await expect(card).not.toHaveAttribute('open');
    await card.locator(':scope > summary').click();
    await expect(card.locator('.auto-review-rationale')).toContainText('当前请求未授权发布该文件');
    await expect(card.locator('.auto-review-operation')).toContainText(
      'https://example.com/review-attachments',
    );
    await expect(card.locator('.auto-review-details')).not.toHaveAttribute('open');
    await expect(card).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await screenshot(page, `auto-review-denied-${viewport.name}`);
    const denied = await currentThread(page, threadId);
    expect(denied.actions).toEqual([]);
    expect(
      denied.turns.at(-1)?.items.filter((item) => item.autoReview?.status === 'denied'),
    ).toHaveLength(1);
    expect(denied.turns.at(-1)?.items.some((item) => item.type === 'commandExecution')).toBe(false);
    await card.getByText('技术详情', { exact: true }).click();
    await expect(card.locator('.auto-review-details')).toHaveAttribute('open', '');
    await expect(card.locator('.auto-review-details')).toContainText('风险评估');
    await page.reload();
    await expect(reviewGroup(page)).not.toHaveAttribute('open');
    await expect(card).not.toHaveAttribute('open');
    await reviewGroup(page).locator(':scope > summary').click();
    await expect(card.locator('.auto-review-status')).toHaveText('已拒绝');
    await expect(card.locator('.auto-review-details')).not.toHaveAttribute('open');
    await context.setOffline(true);
    await expect(page.locator('.connection-badge')).toHaveText('连接已断开');
    await context.setOffline(false);
    await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
    await expect(card).toHaveCount(1);
    await expect(reviewGroup(page)).toHaveAttribute('open', '');
    await expect(card).not.toHaveAttribute('open');
    await card.locator(':scope > summary').click();
    await expect(card.locator('.auto-review-rationale')).toContainText('当前请求未授权发布该文件');
    await expect(card.locator('.auto-review-details')).not.toHaveAttribute('open');
    expect(authorizations).toHaveLength(0);
  });
}

test('an approved review retains manually opened details and permits only the fixture target to run', async ({
  page,
}) => {
  const authorizations: Request[] = [];
  page.on('request', (request) => {
    if (authorizationRequest(request)) authorizations.push(request);
  });
  const threadId = await startReview(
    page,
    '[auto-review-approved] [auto-review-slow] 查看项目状态',
  );
  const card = reviewCard(page);
  await expect(card.locator('.auto-review-status')).toHaveText('审核中');
  await card.locator(':scope > summary').click();
  await card.getByText('技术详情', { exact: true }).click();
  await expect(card.locator('.auto-review-details')).toHaveAttribute('open', '');
  await expect(card.locator('.auto-review-status')).toHaveText('已允许');
  await expect(reviewGroup(page)).toHaveAttribute('open', '');
  await expect(card).toHaveAttribute('open', '');
  await expect(card.locator('.auto-review-details')).toHaveAttribute('open', '');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const thread = await currentThread(page, threadId);
  const review = thread.turns[0]!.items.find((item) => item.autoReview)?.autoReview;
  expect(review?.status).toBe('approved');
  expect(thread.turns[0]!.items.filter((item) => item.type === 'commandExecution')).toEqual([
    expect.objectContaining({
      id: review!.targetItemId,
      command: 'git status --short && git diff --stat',
      status: 'completed',
    }),
  ]);
  expect(thread.actions).toEqual([]);
  expect(authorizations).toHaveLength(0);
});

for (const scenario of [
  { prompt: 'timeout', status: 'timedOut', label: '审核超时', reason: '本次操作未执行' },
  { prompt: 'aborted', status: 'aborted', label: '审核已中止', reason: '本次操作未执行' },
  { prompt: 'unknown', status: 'unknown', label: '结果未确认', reason: '未提供审核原因' },
] as const) {
  test(`a ${scenario.status} review is not presented as a rejection or a grant`, async ({
    page,
  }) => {
    const threadId = await startReview(page, `[auto-review-${scenario.prompt}] 检查自动审核状态`);
    const card = reviewCard(page);
    await expect(card.locator('.auto-review-status')).toHaveText(scenario.label);
    await expect(card).not.toHaveAttribute('open');
    await card.locator(':scope > summary').click();
    await expect(card.locator('.auto-review-rationale')).toContainText(scenario.reason);
    await expect(card.locator('.auto-review-details')).not.toHaveAttribute('open');
    await expect(card.getByRole('button')).toHaveCount(0);
    const thread = await currentThread(page, threadId);
    expect(thread.actions).toEqual([]);
    expect(thread.turns[0]!.items.find((item) => item.autoReview)?.autoReview?.status).toBe(
      scenario.status,
    );
    expect(thread.turns[0]!.items.some((item) => item.type === 'commandExecution')).toBe(false);
  });
}
