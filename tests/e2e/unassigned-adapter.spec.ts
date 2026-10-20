import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime } from './helpers';

test('lists and resumes an unassigned conversation through the real app-server adapter', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await page.goto('/');
  await confirmCompatibility(page);
  await page.getByRole('button', { name: '新建会话（无需项目）', exact: true }).click();
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('直接开始，无需项目 [title-fail]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  const id = await page.evaluate(() => localStorage.getItem('codex-web.selected:@unassigned'));
  expect(id).toBeTruthy();
  const before = await (await request.get(`/api/threads/${id}`)).json();
  const summaries = await (await request.get('/api/unassigned/threads')).json();
  expect(summaries.data).toEqual(
    expect.arrayContaining([expect.objectContaining({ id, projectId: null })]),
  );
  await controlRuntime(request, { restart: true });
  await page.reload();
  await confirmCompatibility(page);
  await expect(page.locator('.user-text')).toHaveText('直接开始，无需项目 [title-fail]');
  await expect(page.locator(`[data-thread-id="${id}"]`)).toBeVisible();
  await expect(page.locator('.composer-resume-status')).toHaveCount(0);
  const after = await (await request.get(`/api/threads/${id}`)).json();
  expect(after).toMatchObject({ projectId: null, cwd: before.cwd });
});
