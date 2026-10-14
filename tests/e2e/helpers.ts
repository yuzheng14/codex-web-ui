import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { SystemInfo } from '../../src/shared/types';
export const compatibilityDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Codex 版本兼容性未经验证' });
export const projectGroup = (page: Page, name = '测试项目') =>
  page.getByRole('region', { name, exact: true, includeHidden: true });
export const createThreadButton = (page: Page) =>
  projectGroup(page).getByRole('button', { name: '新建会话', exact: true, includeHidden: true });
export async function controlRuntime(
  request: APIRequestContext,
  input: { reset?: boolean; version?: string; unavailable?: boolean },
): Promise<SystemInfo> {
  const response = await request.post('http://127.0.0.1:8789/runtime', { data: input });
  expect(response.ok()).toBe(true);
  return (await response.json()) as SystemInfo;
}
export async function confirmCompatibility(page: Page) {
  await expect(compatibilityDialog(page)).toBeVisible();
  await compatibilityDialog(page).getByRole('button', { name: '确认继续', exact: true }).click();
  await expect(compatibilityDialog(page)).not.toBeVisible();
}
