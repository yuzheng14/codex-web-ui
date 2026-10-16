import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Operation, ThreadPage } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

const headers = { Origin: 'http://127.0.0.1:8788' };
test.beforeEach(async ({ page, request }) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
});
test.afterEach(async ({ request }) => {
  const response = await request.get('/api/threads?projectId=fixture');
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
});

test('runs two conversations in one directory and interrupts them independently', async ({
  page,
  request,
}, testInfo) => {
  const owner = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const response = await request.post(`/api/threads/${owner}/turns`, {
    headers,
    data: { clientOperationId: randomUUID(), text: '检查项目改动 [approval]' },
  });
  expect(response.ok()).toBe(true);
  await expect(page.locator('.action-card')).toHaveCount(1);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  const target = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('检查运行设置 [approval]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toHaveCount(1);
  await expect(page.locator('.error-banner.dismissible')).not.toBeVisible();
  for (const id of [owner, target]) {
    await expect(
      page.locator(`[data-thread-id="${id}"]`).locator('..').locator('.thread-status-indicator'),
    ).toHaveAccessibleName(/等待审批/);
  }
  const draft = '仅调整当前会话';
  await page.getByRole('textbox', { name: '追加要求', exact: true }).fill(draft);
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    if (name === 'mobile') await page.getByRole('button', { name: '打开项目与会话' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const path = testInfo.outputPath(`parallel-threads-${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await testInfo.attach(`parallel-threads-${name}`, { path, contentType: 'image/png' });
  }
  await page.locator(`[data-thread-id="${owner}"]`).click();
  await expect(page.getByRole('textbox', { name: '追加要求', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已中断');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(
    page.locator(`[data-thread-id="${target}"]`).locator('..').locator('.thread-status-indicator'),
  ).toHaveAccessibleName(/等待审批/);
  await page.locator(`[data-thread-id="${target}"]`).click();
  await expect(page.getByRole('textbox', { name: '追加要求', exact: true })).toHaveValue(draft);
  await page.getByRole('button', { name: '追加要求', exact: true }).click();
  await expect(
    page.locator('.conversation-content').getByText(draft, { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.action-card')).toHaveCount(1);
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已中断');
});

for (const destination of ['same', 'new'] as const) {
  test(`continues after a missing completion event in the ${destination} conversation`, async ({
    page,
    request,
  }) => {
    await page
      .getByRole('textbox', { name: '任务内容', exact: true })
      .fill('检查设置 [miss-completion]');
    const receipt = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/turns'),
    );
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    const original = (await (await receipt).json()) as Operation;
    // Only the idle notification arrived; do not read history before exercising recovery.
    await expect(page.locator('.topbar .status')).toHaveText('就绪');
    await expect(page.locator('.turn-heading .status').last()).toHaveText('执行中');
    if (destination === 'new') {
      await createThreadButton(page).click();
      await expect(page.getByText('这个会话准备好了')).toBeVisible();
    }
    await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('继续检查');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.turn')).toHaveCount(destination === 'same' ? 2 : 1);
    await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
    await expect(page.locator('.error-banner.dismissible')).not.toBeVisible();
    const operation = (await (
      await request.get(`/api/operations/${original.clientOperationId}`)
    ).json()) as Operation;
    if (destination === 'same') expect(operation.execution?.ended).toBe(true);
    // Creating in the current project may also refresh the old selection. A different
    // thread can proceed regardless of whether that refresh has reconciled the old turn.
  });
}
