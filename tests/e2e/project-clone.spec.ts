import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig } from '../../src/server/config';
import { startGateway } from '../../src/server/main';
import { DomainCodex } from '../integration/domain-helpers';
import { gitCloneFixture } from '../helpers/git-clone';
import Database from 'better-sqlite3';

let directory: string;
let origin: string;
let runtime: Awaited<ReturnType<typeof startGateway>>;
let previous: Record<string, string | undefined>;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'covro-clone-browser-'));
  const env = gitCloneFixture(directory);
  previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  await new Promise<void>((done) => probe.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  const config = parseConfig(
    { port: address.port, publicOrigin: [origin], dataDir: join(directory, 'data') },
    join(directory, 'config.json'),
  );
  config.demo = true;
  const codex = new DomainCodex();
  codex.onStart = (id, turn) => setTimeout(() => codex.complete(id, turn.id), 50);
  runtime = await startGateway(config, {
    codex,
    staticDir: resolve('dist/web'),
  });
});
test.afterEach(async () => {
  await runtime?.close();
  for (const [key, value] of Object.entries(previous ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});
async function form(page: Page, repository: string, target = 'project') {
  await page.getByRole('button', { name: '添加项目', exact: true }).last().click();
  const dialog = page.getByRole('dialog', { name: '添加服务器项目' });
  await dialog.getByRole('button', { name: '克隆 Git 仓库', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Git 仓库地址', exact: true }).fill(repository);
  await dialog
    .getByRole('textbox', { name: '服务器目标目录', exact: true })
    .fill(join(directory, target));
  await dialog.getByRole('textbox', { name: '项目名称（可选）', exact: true }).fill('克隆示例项目');
  return dialog;
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('clones and imports a real checkout, opens the project, and protects occupied destinations', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin);
  const dialog = await form(page, 'https://example.test/project.git');
  await screenshot(page, info, 'clone-form-desktop');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆完成，项目已添加');
  await screenshot(page, info, 'clone-success-desktop');
  expect(await readFile(join(directory, 'project', 'README.md'), 'utf8')).toBe(
    '# Cloned project\n',
  );
  await dialog.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('region', { name: '克隆示例项目', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '任务内容', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('在克隆项目中开始工作');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const conflict = await form(page, 'git@example.test:org/project.git');
  await conflict.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(conflict.getByRole('alert')).toContainText('该目录已添加为项目');
  await screenshot(page, info, 'clone-conflict-desktop');
});

test('shows progress, restores after reload, rejects duplicate requests and cancels on mobile', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  let dialog = await form(page, 'https://example.test/slow.git');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('正在接收对象 42%');
  await screenshot(page, info, 'clone-progress-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const duplicate = await page.request.post(`${origin}/api/project-clones`, {
    headers: { Origin: origin },
    data: {
      clientOperationId: crypto.randomUUID(),
      repository: 'https://example.test/slow.git',
      path: join(directory, 'project'),
    },
  });
  expect(duplicate.status()).toBe(409);
  await page.reload();
  await page.getByRole('button', { name: '添加项目', exact: true }).last().click();
  dialog = page.getByRole('dialog', { name: '添加服务器项目' });
  await dialog.getByRole('button', { name: '克隆 Git 仓库', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('正在接收对象 42%');
  await dialog.getByRole('button', { name: '取消克隆', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已取消克隆');
  await expect(dialog.getByRole('alert')).toContainText('未添加项目，也未删除任何文件');
  await screenshot(page, info, 'clone-cancelled-mobile');
  expect((await (await page.request.get(`${origin}/api/projects`)).json()).data).toEqual([]);
});

test('shows safe authentication failure and permits retry with another empty directory', async ({
  page,
}, info) => {
  await page.goto(origin);
  const dialog = await form(page, 'https://example.test/auth.git');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆失败');
  await expect(dialog.getByRole('alert')).toContainText('Git 认证失败');
  expect(await dialog.innerText()).not.toMatch(/TOP_SECRET|HIDDEN_TOKEN/);
  await screenshot(page, info, 'clone-auth-failure-desktop');
  await dialog.getByRole('button', { name: '使用空目录重试', exact: true }).click();
  await dialog
    .getByRole('textbox', { name: 'Git 仓库地址', exact: true })
    .fill('ssh://git@example.test/org/project.git');
  await dialog
    .getByRole('textbox', { name: '服务器目标目录', exact: true })
    .fill(join(directory, 'retry'));
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆完成，项目已添加');
});

test('offers registration retry without a second clone', async ({ page }, info) => {
  const database = new Database(join(directory, 'data', 'app.sqlite'));
  database.exec(
    "CREATE TRIGGER fail_clone_registration BEFORE INSERT ON project_registrations BEGIN SELECT RAISE(FAIL, 'fixture registration failure'); END",
  );
  await page.goto(origin);
  const dialog = await form(page, 'https://example.test/project.git');
  await dialog.getByRole('button', { name: '克隆并添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆已完成，项目尚未添加');
  await screenshot(page, info, 'clone-registration-failure-desktop');
  database.exec('DROP TRIGGER fail_clone_registration');
  database.close();
  await dialog.getByRole('button', { name: '重试添加项目', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('克隆完成，项目已添加');
  expect((await readFile(join(directory, 'git-calls'), 'utf8')).trim().split('\n')).toHaveLength(1);
});
