import { expect, test, type Page } from '@playwright/test';
import type { Project, ThreadSummary } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime } from './helpers';

// Chromium may round translated bounds by one 1/64 CSS-pixel layout unit.
const pixelTolerance = 1 / 64;

const longName = 'Codex Web UI · 多项目工作区与会话导航布局验证';
const longPath =
  '/workspace/engineering/customer-platform/frontend/codex-web-ui/long-project-directory';

async function seedSidebar(page: Page) {
  let reads = 0;
  await page.route('**/api/projects', async (route) => {
    const response = await route.fetch();
    const result = (await response.json()) as { data: Project[] };
    result.data[0] = { ...result.data[0]!, name: longName, rootPath: longPath };
    await route.fulfill({ response, json: result });
  });
  await page.route('**/api/projects/fixture/threads*', async (route) => {
    reads++;
    const response = await route.fetch();
    const result = await response.json();
    const archived = new URL(route.request().url()).searchParams.has('archived');
    const data: ThreadSummary[] = Array.from({ length: archived ? 1 : 30 }, (_, index) => ({
      id: `${archived ? 'archived' : 'active'}-${index}`,
      projectId: 'fixture',
      title: archived ? '保存的归档记录' : `会话 ${index + 1}：检查项目配置与运行结果`,
      source: 'appServer',
      managed: false,
      archived,
      status: 'idle',
      pendingActionCount: 0,
    }));
    await route.fulfill({ response, json: { ...result, data, nextCursor: null } });
  });
  return () => reads;
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

for (const viewport of [
  // The empty unassigned group stays visible so its create button is discoverable.
  { width: 1280, height: 900, minimumRows: 12 },
  { width: 1024, height: 768, minimumRows: 9 },
  { width: 390, height: 844, minimumRows: 11 },
  { width: 320, height: 568, minimumRows: 3 },
]) {
  test(`compact sidebar keeps controls and long project details bounded at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await seedSidebar(page);
    await page.goto('/');
    await confirmCompatibility(page);
    if (viewport.width < 760) await page.getByRole('button', { name: '打开项目与会话' }).click();
    await expect(page.locator('[data-thread-id]')).toHaveCount(30);
    const sidebar = page.getByRole('complementary', { name: '项目与会话' });
    await expect(sidebar).toBeInViewport();
    await expect(
      sidebar
        .getByRole('region', { name: '未关联项目', exact: true })
        .locator('.project-heading')
        .getByRole('button', { name: '新建会话（无需项目）', exact: true }),
    ).toBeInViewport();
    const metrics = await sidebar.evaluate((element) => {
      const tolerance = 1 / 64;
      const sidebar = element.getBoundingClientRect();
      const list = element.querySelector('.project-list')!.getBoundingClientRect();
      return {
        fixedTopHeight: list.top - sidebar.top,
        visibleRows: [...element.querySelectorAll('[data-thread-id]')].filter((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.top >= list.top && bounds.bottom <= list.bottom;
        }).length,
        overflow: element.scrollWidth > element.clientWidth,
        controls: [...element.querySelectorAll('.sidebar-header button, .sidebar-header input')]
          .filter((control) => control.getClientRects().length > 0)
          .map((control) => {
            const bounds = control.getBoundingClientRect();
            return {
              inside:
                bounds.left >= sidebar.left - tolerance &&
                bounds.right <= sidebar.right + tolerance,
              width: bounds.width,
              height: bounds.height,
            };
          }),
      };
    });
    // The old fixed area was 280+ px; keep three readable rows and stable click targets.
    expect(metrics.fixedTopHeight).toBeLessThanOrEqual(150);
    expect(metrics.visibleRows).toBeGreaterThanOrEqual(viewport.minimumRows);
    expect(metrics.overflow).toBe(false);
    for (const control of metrics.controls) {
      expect(control.inside).toBe(true);
      expect(control.width).toBeGreaterThanOrEqual(32 - pixelTolerance);
      expect(control.height).toBeGreaterThanOrEqual(32 - pixelTolerance);
    }
    const project = sidebar.getByRole('region', { name: longName, exact: true });
    await expect(project.locator('.project-link')).toHaveAccessibleDescription(longName);
    await expect(project).not.toContainText(longPath);
    const heading = project.locator('.project-heading');
    const create = project.getByRole('button', { name: '新建会话', exact: true });
    await expect(create).toHaveAccessibleDescription(
      /^新建会话 · (⌘ \+ ⌥ \+ ⇧ \+ N|Ctrl \+ Alt \+ Shift \+ N)$/,
    );
    await expect(create).toHaveText('');
    // Read every bound in one frame, including while the mobile drawer slides in.
    const headingMetrics = await heading.evaluate((element) => {
      const tolerance = 1 / 64;
      const heading = element.getBoundingClientRect();
      return {
        height: heading.height,
        buttons: [...element.querySelectorAll('button')].map((button) => {
          const bounds = button.getBoundingClientRect();
          return {
            inside:
              bounds.top >= heading.top - tolerance &&
              bounds.bottom <= heading.bottom + tolerance &&
              bounds.left >= heading.left - tolerance &&
              bounds.right <= heading.right + tolerance,
            width: bounds.width,
          };
        }),
      };
    });
    expect(headingMetrics.height).toBeLessThanOrEqual(40);
    for (const button of headingMetrics.buttons) {
      expect(button.inside).toBe(true);
      expect(button.width).toBeGreaterThanOrEqual(32 - pixelTolerance);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    // A short project name/path must use the same header height as the long variant.
    await page.route('**/api/projects', async (route) => {
      const response = await route.fetch();
      const result = (await response.json()) as { data: Project[] };
      result.data[0] = { ...result.data[0]!, name: '短项目', rootPath: '/work/app' };
      await route.fulfill({ response, json: result });
    });
    await page.reload();
    if (viewport.width < 760) await page.getByRole('button', { name: '打开项目与会话' }).click();
    await expect(sidebar.getByRole('region', { name: '短项目', exact: true })).toBeVisible();
    await expect(sidebar.locator('[data-thread-id]')).toHaveCount(30);
    const shortHeight = await sidebar.evaluate(
      (element) =>
        element.querySelector('.project-list')!.getBoundingClientRect().top -
        element.getBoundingClientRect().top,
    );
    expect(shortHeight).toBe(metrics.fixedTopHeight);
    const path = testInfo.outputPath(`sidebar-header-${viewport.width}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await testInfo.attach('sidebar-layout', { path, contentType: 'image/png' });
  });
}

test('narrow sidebar retains search, archive switching, refresh and project dialogs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const reads = await seedSidebar(page);
  await page.goto('/');
  await confirmCompatibility(page);
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  const sidebar = page.getByRole('complementary', { name: '项目与会话' });
  const search = sidebar.getByRole('searchbox', { name: '搜索项目与已加载会话' });
  await search.fill(longPath);
  await expect(sidebar.locator('[data-thread-id]')).toHaveCount(30);
  await search.fill('会话 17：');
  await expect(sidebar.locator('[data-thread-id]')).toHaveCount(1);
  await expect(sidebar.locator('[data-thread-id]')).toHaveText(/会话 17：/);
  await search.fill('不存在的会话');
  await expect(sidebar.getByText('没有匹配的项目或已加载会话。')).toBeVisible();
  await search.fill('');
  await sidebar.getByRole('button', { name: '已归档会话', exact: true }).click();
  await expect(sidebar.locator('[data-thread-id="archived-0"]')).toBeVisible();
  await sidebar.getByRole('button', { name: '会话', exact: true }).click();
  await expect(sidebar.locator('[data-thread-id]')).toHaveCount(30);
  const previous = reads();
  await sidebar.getByRole('button', { name: '刷新会话列表' }).click();
  await expect.poll(reads).toBeGreaterThan(previous);
  await sidebar.getByRole('button', { name: '添加项目', exact: true }).click();
  const add = page.getByRole('dialog', { name: '添加服务器项目', exact: true });
  await expect(add).toBeVisible();
  await add.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await sidebar.getByRole('button', { name: `管理项目 ${longName}`, exact: true }).click();
  const manage = page.getByRole('dialog', { name: '管理项目', exact: true });
  await expect(manage).toContainText(longPath);
  await expect(manage.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue(
    longName,
  );
  await manage.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await sidebar.getByRole('button', { name: '关闭导航', exact: true }).click();
  await expect(sidebar).not.toHaveClass(/sidebar-open/);
});
