import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { SystemInfo } from '../../src/shared/types';
export const testOrigin = `http://127.0.0.1:${process.env.E2E_PORT ?? 8788}`;
export const compatibilityDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Codex 版本兼容性未经验证' });
export const projectGroup = (page: Page, name = '测试项目') =>
  page.getByRole('region', { name, exact: true, includeHidden: true });
export const createThreadButton = (page: Page) =>
  projectGroup(page).getByRole('button', { name: '新建会话', exact: true, includeHidden: true });
/** The shared welcome page also appears before creation; wait for the selected thread. */
export async function expectThreadReady(page: Page) {
  await expect(page.getByTestId('workspace-start')).toHaveAttribute('data-thread-ready', 'true');
}
export async function controlRuntime(
  request: APIRequestContext,
  input: {
    reset?: boolean;
    restart?: boolean;
    version?: string;
    unavailable?: boolean;
    external?: 'free' | 'occupied' | 'error';
    releaseThreadId?: string;
  },
): Promise<SystemInfo & { externalThreadId?: string }> {
  const response = await request.post(
    `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 8788) + 1}/runtime`,
    { data: input },
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as SystemInfo;
}
export async function confirmCompatibility(page: Page) {
  await expect(compatibilityDialog(page)).toBeVisible();
  await compatibilityDialog(page).getByRole('button', { name: '确认继续', exact: true }).click();
  await expect(compatibilityDialog(page)).not.toBeVisible();
}
/** Tests that navigate through history must first start a real conversation. */
export async function saveConversationHistory(page: Page) {
  const turns = await page.locator('.turn').count();
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('已有会话历史 [title-fail]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn')).toHaveCount(turns + 1);
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
}

/** Fixture setup for regressions requiring an empty native session. The real first-message
 * creation path runs, but this setup-only send is acknowledged without dispatching a turn.
 * This keeps other in-memory drafts intact and avoids coupling fixtures to /new semantics. */
export async function createEmptyThread(page: Page, projectName = '测试项目') {
  await projectGroup(page, projectName)
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  const setup = `empty-session-fixture:${randomUUID()}`;
  const acknowledgeSetup = async (route: Route) => {
    const input = route.request().postDataJSON() as { text: string; clientOperationId: string };
    if (input.text !== setup) return route.fallback();
    const target = new URL(route.request().url()).pathname.split('/')[3]!;
    await route.fulfill({
      json: {
        clientOperationId: input.clientOperationId,
        kind: 'turn.start',
        target,
        status: 'acknowledged',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
  };
  await page.route('**/api/threads/*/turns', acknowledgeSetup);
  try {
    const input = page.locator('.composer-box textarea');
    await input.fill(setup);
    await input.press('Enter');
    await expectThreadReady(page);
    await expect(input).toHaveValue('');
    await expect(page.locator('.composer-resume-status')).toHaveCount(0);
  } finally {
    await page.unroute('**/api/threads/*/turns', acknowledgeSetup);
  }
}
