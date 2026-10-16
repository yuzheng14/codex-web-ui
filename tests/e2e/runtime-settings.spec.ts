import { expect, test } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createThreadButton, projectGroup } from './helpers';

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

test('direct selectors show reported settings, keep proposals distinct and follow server confirmation', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  await expect(model).toHaveValue('simulated-model');
  await expect(effort).toHaveValue('medium');
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  await expect(effort).toHaveValue('medium');
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-toolbar-direct.png' });
  await effort.selectOption('high');
  await expect(page.locator('.settings-pending')).toContainText(
    '下次任务生效 · 当前 simulated-model / medium',
  );
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-toolbar-pending.png' });
  await page.getByRole('textbox', { name: '任务内容' }).fill('确认推理强度设置');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(effort).toBeDisabled();
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
  await expect(effort).toHaveValue('high');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  await expect(effort).toBeEnabled();
  await effort.selectOption('low');
  await page.getByRole('button', { name: '撤销修改' }).click();
  await expect(effort).toHaveValue('high');
  await page.reload();
  await expect(effort).toHaveValue('high');
  await page.getByRole('button', { name: '权限与审批设置' }).click();
  await expect(page.getByRole('combobox', { name: '权限范围', exact: true })).toHaveValue(
    'read-only',
  );
  await expect(page.getByRole('combobox', { name: '审批策略', exact: true })).toHaveValue(
    'on-request',
  );
  await expect(page.locator('.settings-observed')).toContainText('当前网络权限：受限');
  await expect(page.locator('.settings-panel')).not.toContainText('继承');
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-toolbar-advanced.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
  await page.getByRole('button', { name: '关闭导航', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: '/tmp/codex-toolbar-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '权限与审批设置' }).click();
  await page.screenshot({ path: '/tmp/codex-toolbar-mobile-collapsed.png', fullPage: true });
});

test('isolates unsent edits by session and sends only explicit edits', async ({ page }) => {
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  const first = await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture'));
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  await effort.selectOption('high');
  await createThreadButton(page).click();
  await expect(effort).toHaveValue('medium');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
  await page.locator(`[data-thread-id="${first}"]`).click();
  await expect(effort).toHaveValue('high');
  const sending = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/turns'),
  );
  await page.getByRole('textbox', { name: '任务内容' }).fill('独立会话配置');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  expect((await sending).postDataJSON().settings).toEqual({ reasoningEffort: 'high' });
  await expect(page.getByText('模拟任务已完成。', { exact: true })).toBeVisible();
});

test('keeps project defaults isolated when a previous project responds late', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects/fixture/runtime-settings', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await projectGroup(page, '另一个项目')
    .getByRole('button', { name: '另一个项目', exact: true })
    .click();
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  await expect(effort).toHaveValue('high');
  const oldResponse = page.waitForResponse('**/api/projects/fixture/runtime-settings');
  release();
  await oldResponse;
  await expect(effort).toHaveValue('high');
});

test('retries unavailable defaults and preserves unknown or custom values without inventing defaults', async ({
  page,
}) => {
  let failed = true;
  await page.route('**/runtime-settings', async (route) => {
    if (failed)
      await route.fulfill({
        status: 503,
        json: { error: { code: 'CODEX_UNAVAILABLE', message: 'unavailable' } },
      });
    else
      await route.fulfill({
        json: {
          model: 'private-custom-model',
          reasoningEffort: null,
          sandbox: 'external-sandbox',
          approvalPolicy: 'granular',
          networkAccess: true,
          approvalReviewer: 'auto_review',
        },
      });
  });
  await page.goto('/');
  await confirmCompatibility(page);
  await expect(page.locator('.settings-error')).toContainText('无法读取默认配置');
  failed = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveValue(
    'private-custom-model',
  );
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  await expect(effort.locator('option:checked')).toHaveText('未报告');
  await expect(effort).toBeDisabled();
  await page.getByRole('button', { name: '权限与审批设置' }).click();
  await expect(page.getByRole('combobox', { name: '权限范围', exact: true })).toHaveValue(
    'external-sandbox',
  );
  await expect(page.getByRole('combobox', { name: '审批策略', exact: true })).toHaveValue(
    'granular',
  );
  await expect(page.locator('.settings-observed')).toContainText('当前网络权限：允许');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
});

test('restored saved settings stay distinct from edits until the next task confirms them', async ({
  page,
  request,
}) => {
  const { externalThreadId: id } = await controlRuntime(request, { external: 'occupied' });
  await page.addInitScript((id) => {
    localStorage.setItem('codex-web.project', 'fixture');
    localStorage.setItem('codex-web.selected:fixture', id!);
  }, id);
  await page.goto('/');
  await confirmCompatibility(page);
  const notice = page.locator('.session-resume-notice');
  await expect(notice).toContainText('此会话正被其他进程使用');
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  await expect(effort).toHaveValue('medium');
  await page.getByRole('button', { name: '权限与审批设置' }).click();
  // Seeding this fixture emits a settings notification, so its actual policy is already known.
  await expect(page.getByRole('combobox', { name: '权限范围', exact: true })).toHaveValue(
    'read-only',
  );
  await expect(page.locator('.settings-heading')).toContainText('会话保存配置');
  await effort.selectOption('high');
  await expect(page.locator('.settings-pending')).toContainText('恢复后发送或 Fork 时生效');
  await controlRuntime(request, { releaseThreadId: id });
  const resuming = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().endsWith('/resume'),
  );
  await notice.getByRole('button', { name: '重试恢复', exact: true }).click();
  expect((await resuming).postDataJSON().settings).toBeUndefined();
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.settings-pending')).toContainText(
    '下次任务生效 · 当前 simulated-model / medium',
  );
  await expect(effort).toHaveValue('high');
  await expect(page.getByRole('combobox', { name: '权限范围', exact: true })).toHaveValue(
    'read-only',
  );
  await page.getByRole('textbox', { name: '任务内容' }).fill('恢复后应用选择');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(effort).toHaveValue('high');
  await expect(page.locator('.settings-pending')).toHaveCount(0);
});

test('one-row controls stay grouped on desktop and narrow screens, with distinct effort gauges', async ({
  page,
  request,
}) => {
  await page.route('**/api/projects/fixture/runtime-settings', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        model: 'private-model-with-a-very-long-provider-and-version-name',
      },
    });
  });
  await page.goto('/');
  await confirmCompatibility(page);
  const row = page.locator('.composer-actions');
  const policy = row.getByRole('button', { name: '权限与审批设置', exact: true });
  const model = row.getByRole('combobox', { name: '模型', exact: true });
  const effort = row.getByRole('combobox', { name: '推理强度', exact: true });
  const send = row.getByRole('button', { name: '发送任务', exact: true });
  await expect(model).toHaveValue('private-model-with-a-very-long-provider-and-version-name');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const elements = [page.locator('.composer-target'), policy, model, effort, send];
    const boxes = await Promise.all(elements.map((element) => element.boundingBox()));
    const centers = boxes.map((box) => box!.y + box!.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
    for (let index = 1; index < boxes.length; index++)
      expect(boxes[index]!.x).toBeGreaterThanOrEqual(boxes[index - 1]!.x + boxes[index - 1]!.width);
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page
      .locator('.composer-box')
      .screenshot({ path: `/tmp/codex-toolbar-long-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  const gauge = page.locator('.reasoning-gauge');
  await effort.selectOption('low');
  const low = Number(await gauge.getAttribute('data-progress'));
  await expect(effort).toHaveAttribute('title', '推理强度：low');
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-toolbar-low.png' });
  await effort.selectOption('high');
  expect(Number(await gauge.getAttribute('data-progress'))).toBeGreaterThan(low);
  await expect(effort).toHaveAttribute('title', '推理强度：high');
  await page.locator('.composer-box').screenshot({ path: '/tmp/codex-toolbar-high.png' });
  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[approval] 检查运行中的发送栏');
  await send.click();
  await expect(page.locator('.action-card')).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const elements = [
      page.locator('.composer-target'),
      policy,
      model,
      effort,
      row.getByRole('button', { name: '中断', exact: true }),
      row.getByRole('button', { name: '追加要求', exact: true }),
    ];
    const boxes = await Promise.all(elements.map((element) => element.boundingBox()));
    const centers = boxes.map((box) => box!.y + box!.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
    for (let index = 1; index < boxes.length; index++)
      expect(boxes[index]!.x).toBeGreaterThanOrEqual(boxes[index - 1]!.x + boxes[index - 1]!.width);
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page
      .locator('.composer-box')
      .screenshot({ path: `/tmp/codex-toolbar-active-${width}.png` });
  }
  await row.getByRole('button', { name: '中断', exact: true }).click();
  await expect(row.getByRole('button', { name: '中断', exact: true })).toHaveCount(0);
  await controlRuntime(request, { reset: true });
});
