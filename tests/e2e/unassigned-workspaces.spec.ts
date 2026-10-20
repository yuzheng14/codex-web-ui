import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { parseConfig, type AppConfig } from '../../src/server/config';
import { startGateway } from '../../src/server/main';
import { DomainCodex } from '../integration/domain-helpers';

let root: string, origin: string, config: AppConfig, codex: DomainCodex;
let runtime: Awaited<ReturnType<typeof startGateway>>;
const input = (page: Page) => page.getByRole('textbox', { name: '任务内容', exact: true });
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });
const globalNew = (page: Page) =>
  page
    .getByRole('region', { name: '未关联项目', exact: true })
    .getByRole('button', { name: '新建会话（无需项目）', exact: true });
const selected = (page: Page) =>
  page.evaluate(() => localStorage.getItem('codex-web.selected:@unassigned'));
const start = async () => {
  runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
};
async function complete(page: Page) {
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
  await expect(input(page)).toHaveValue('');
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'covro-workspace-browser-'));
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  await new Promise<void>((done) => probe.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  config = parseConfig(
    { port: address.port, publicOrigin: [origin], dataDir: join(root, 'data') },
    join(root, 'config.json'),
  );
  config.demo = true;
  codex = new DomainCodex();
  const diagnostics = codex.diagnostics.bind(codex);
  codex.diagnostics = () => ({
    ...diagnostics(),
    capabilities: [
      'thread/start',
      'thread/read',
      'thread/resume',
      'thread/fork',
      'thread/name/set',
      'thread/archive',
      'thread/unarchive',
    ],
  });
  codex.onStart = (id, turn) => {
    setTimeout(() => codex.complete(id, turn.id), 50);
  };
  await start();
});
test.afterEach(async () => {
  await runtime.close();
  await rm(root, { recursive: true, force: true });
});

test('starts without any projects and retains files, names and archive state after a gateway restart', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  await expect(
    page.getByText('无需选择项目，发送后自动分配独立工作目录；会话和文件将持续保留。'),
  ).toBeVisible();
  await input(page).fill('整理一份周末出行计划');
  await expect(send(page)).toBeEnabled();
  expect(runtime.service.listProjects()).toEqual([]);
  await expect.poll(async () => (await readdir(join(root, 'data', 'workspaces'))).length).toBe(0);
  await screenshot(page, info, '184-no-project-entry');
  await send(page).click();
  await complete(page);
  const id = (await selected(page))!;
  const thread = await runtime.service.getThread(id);
  expect(thread.projectId).toBeNull();
  await writeFile(join(thread.cwd, 'itinerary.md'), '# 周末出行计划\n文件会持续保留。');
  await page.getByRole('button', { name: '重命名会话' }).click();
  await page.getByRole('textbox', { name: '会话名称' }).fill('周末出行计划');
  await page.getByRole('button', { name: '保存会话名称', exact: true }).click();
  await expect(page.locator('.thread-title-trigger')).toContainText('周末出行计划');
  await page.locator('.workspace-directory summary').click();
  await screenshot(page, info, '184-unassigned-conversation');
  await runtime.close();
  codex.epoch = 'restarted-browser';
  await start();
  await page.reload();
  await expect(page.locator('.user-text')).toHaveText('整理一份周末出行计划');
  await expect(page.locator('.thread-title-trigger')).toContainText('周末出行计划');
  expect((await runtime.service.getThread(id)).cwd).toBe(thread.cwd);
  const preview = await page.request.get(`${origin}/api/threads/${id}/markdown?path=itinerary.md`);
  expect((await preview.json()).content).toContain('文件会持续保留');
  await screenshot(page, info, '184-restored-conversation');
  const row = page.locator('.thread-row').filter({ has: page.locator(`[data-thread-id="${id}"]`) });
  await row.getByRole('button', { name: '归档会话', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(await readFile(join(thread.cwd, 'itinerary.md'), 'utf8')).toContain('持续保留');
  await page.getByRole('button', { name: '已归档会话', exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '取消归档', exact: true }).click();
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await row.locator('.thread-link').click();
  await expect(page.locator('.user-text')).toHaveText('整理一份周末出行计划');
  expect(await readdir(join(root, 'data', 'workspaces'))).toHaveLength(1);
});

test('retains failed prompts and retries the first turn without allocating another workspace', async ({
  page,
}) => {
  await page.goto(origin);
  let creations = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/unassigned/threads'))
      creations++;
  });
  await page.route('**/api/unassigned/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 409,
      json: { error: { code: 'WORKSPACE_UNAVAILABLE', message: '工作目录不可写，请重试' } },
    });
  });
  await input(page).fill('保留这条消息，修复目录后继续');
  await send(page).click();
  await expect(page.locator('.error-banner.dismissible')).toContainText('工作目录不可写');
  await expect(input(page)).toHaveValue('保留这条消息，修复目录后继续');
  await expect(send(page)).toBeEnabled();
  await page.unroute('**/api/unassigned/threads');
  await page.route('**/api/threads/*/turns', (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'SEND_FAILED', message: '首轮发送失败' } },
    }),
  );
  await send(page).click();
  await expect(page.locator('.error-banner.dismissible')).toContainText('首轮发送失败');
  await expect(input(page)).toHaveValue('保留这条消息，修复目录后继续');
  const id = await selected(page);
  expect(await readdir(join(root, 'data', 'workspaces'))).toHaveLength(1);
  await page.unroute('**/api/threads/*/turns');
  await send(page).click();
  await complete(page);
  expect(await selected(page)).toBe(id);
  expect(creations).toBe(2); // One rejected request, one actual allocation.
  expect(codex.creates).toBe(1);
});

test('global new switches out of a project, isolates drafts, and works on mobile', async ({
  page,
}, info) => {
  const projectPath = join(root, 'example-project');
  await mkdir(projectPath);
  const project = runtime.service.addProject({ path: projectPath, name: '示例项目' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await expect(page.locator('.breadcrumb')).toContainText('示例项目');
  await input(page).fill('项目中的草稿');
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await globalNew(page).click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
  await expect(page.locator('.breadcrumb')).toContainText('未关联项目');
  await expect(input(page)).toHaveValue('');
  await input(page).fill('无需项目，也可以开始工作');
  await screenshot(page, info, '184-mobile-entry');
  await send(page).click();
  await complete(page);
  const id = (await selected(page))!;
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await page
    .locator(`[data-project-id="${project.id}"]`)
    .getByRole('button', { name: '示例项目', exact: true })
    .click();
  await expect(input(page)).toHaveValue('项目中的草稿');
  await page.getByRole('button', { name: '打开项目与会话' }).click();
  await page.locator(`[data-thread-id="${id}"]`).click();
  await expect(page.locator('.user-text')).toHaveText('无需项目，也可以开始工作');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(page, info, '184-mobile-conversation');
});
