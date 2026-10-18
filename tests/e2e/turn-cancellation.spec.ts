import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Operation, ThreadView } from '../../src/shared/types';
import {
  confirmCompatibility,
  controlRuntime,
  createEmptyThread,
  expectThreadReady,
} from './helpers';

const headers = { Origin: `http://127.0.0.1:${process.env.E2E_PORT ?? 8788}` };
test('late cancellation events leave the following turn and its approval active', async ({
  page,
  request,
}, testInfo) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await createEmptyThread(page);
  await expectThreadReady(page);
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const first = await request.post(`/api/threads/${id}/turns`, {
    headers,
    data: {
      clientOperationId: randomUUID(),
      text: '取消前一轮检查 [approval] [interrupt-ack-first]',
    },
  });
  const original = (await first.json()) as Operation;
  await expect(page.locator('.action-card')).toHaveCount(1);
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(page.locator('.turn-heading .status').first()).toHaveText('已中断');
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('继续下一轮检查 [approval]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const thread = async () => (await (await request.get(`/api/threads/${id}`)).json()) as ThreadView;
  await expect
    .poll(
      async () =>
        (await thread()).turns[0]?.items.find((item) => item.id === 'cancelled-nested-tool')
          ?.output,
    )
    .toBe('旧工具取消完成');
  await expect(page.locator('.topbar .status')).toHaveText('等待审批');
  await expect(page.locator('.turn-heading .status').last()).toHaveText('等待审批');
  await expect(page.getByRole('button', { name: '中断', exact: true })).toBeEnabled();
  const current = await thread();
  expect(current.execution?.turnId).toBe(current.turns[1]?.id);
  expect(
    current.actions.find(
      (action) => action.turnId === (original.result as { turnId: string }).turnId,
    )?.status,
  ).toBe('expired');
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    const path = testInfo.outputPath(`cancellation-${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  }
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已中断');
});
