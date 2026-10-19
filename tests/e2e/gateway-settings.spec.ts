import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { loadConfig } from '../../src/server/config';
import { startGateway } from '../../src/server/main';
import { DomainCodex } from '../integration/domain-helpers';

let root: string, path: string, origin: string;
let runtime: Awaited<ReturnType<typeof startGateway>>;
const settings = (page: Page) => page.getByRole('dialog', { name: '服务配置', exact: true });
async function start() {
  runtime = await startGateway(await loadConfig({ configPath: path, development: false }), {
    codex: new DomainCodex(),
    staticDir: resolve('dist/web'),
  });
}
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'covro-settings-browser-'));
  path = join(root, 'config.json');
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  await new Promise<void>((done) => probe.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    path,
    JSON.stringify({ port: address.port, publicOrigin: [origin], dataDir: './data' }),
  );
  await start();
});
test.afterEach(async () => {
  await runtime?.close();
  await rm(root, { recursive: true, force: true });
});
async function open(page: Page) {
  await page.goto(origin);
  if (page.viewportSize()!.width <= 760)
    await page.getByRole('button', { name: '打开项目与会话' }).click();
  await page.getByRole('button', { name: '服务配置', exact: true }).click();
  await expect(settings(page).getByLabel('Codex 可执行文件', { exact: true })).toHaveValue('codex');
}
async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('edit, review, save and restart distinguish file settings from running values', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await open(page);
  await capture(page, info, 'gateway-settings-desktop');
  const dialog = settings(page);
  await dialog.getByLabel('请求超时（毫秒）', { exact: true }).fill('18000');
  await dialog.getByRole('button', { name: '检查更改' }).click();
  await expect(dialog.getByRole('region', { name: '保存配置预览' })).toContainText('18000');
  expect(JSON.parse(await readFile(path, 'utf8')).codex).toBeUndefined();
  await capture(page, info, 'gateway-settings-review');
  await dialog.getByRole('button', { name: '确认保存' }).click();
  await expect(dialog.getByText('已保存，待重启生效', { exact: true })).toBeVisible();
  await expect(dialog.getByText('当前运行：30000', { exact: true })).toBeVisible();
  expect(JSON.parse(await readFile(path, 'utf8')).codex.requestTimeoutMs).toBe(18000);
  await dialog.evaluate((node) => {
    node.scrollTop = 0;
  });
  await capture(page, info, 'gateway-settings-saved');
  await runtime.close();
  await start();
  await page.reload();
  await page.getByRole('button', { name: '服务配置', exact: true }).click();
  await expect(
    settings(page).getByText('已保存配置与当前运行配置一致', { exact: true }),
  ).toBeVisible();
  await expect(settings(page).getByLabel('请求超时（毫秒）', { exact: true })).toHaveValue('18000');
});

test('mobile import previews JSON, preserves local data, and exports saved values', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const dialog = settings(page);
  const before = await readFile(path, 'utf8');
  await dialog
    .getByLabel('选择配置文件', { exact: true })
    .setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
  await expect(dialog.getByRole('alert')).toContainText('无法解析 JSON');
  await dialog.getByLabel('选择配置文件', { exact: true }).setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ unknown: true })),
  });
  await expect(dialog.getByRole('alert')).toContainText('Unrecognized');
  const imported = {
    ...JSON.parse(before),
    dataDir: '/other/data',
    projects: [{ id: 'foreign', name: 'Other machine', path: '/other/project' }],
    codex: { binary: '/usr/local/bin/codex', requestTimeoutMs: 15000 },
  };
  await dialog.getByLabel('选择配置文件', { exact: true }).setInputFiles({
    name: 'config.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(dialog.getByRole('region', { name: '导入配置预览' })).toContainText(
    '已忽略导入文件中的 dataDir、projects',
  );
  expect(await readFile(path, 'utf8')).toBe(before);
  await capture(page, info, 'gateway-settings-import-mobile');
  await dialog.getByRole('button', { name: '应用到表单' }).click();
  await expect(dialog.getByLabel('Codex 可执行文件', { exact: true })).toHaveValue(
    '/usr/local/bin/codex',
  );
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出已保存配置' }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toBe('codex-web-config.json');
  expect(JSON.parse(await readFile((await exported.path())!, 'utf8')).codex.binary).toBe('codex');
  await dialog.getByRole('button', { name: '检查更改' }).click();
  await dialog.getByRole('button', { name: '确认保存' }).click();
  await expect(dialog.getByText('已保存，待重启生效', { exact: true })).toBeVisible();
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
    dataDir: './data',
    projects: [],
    codex: { binary: '/usr/local/bin/codex', requestTimeoutMs: 15000 },
  });
  await dialog.evaluate((node) => {
    node.scrollTop = 0;
  });
  await capture(page, info, 'gateway-settings-mobile');
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('validation, stale writes and close confirmation preserve user edits', async ({
  page,
  context,
}) => {
  await open(page);
  const dialog = settings(page);
  await dialog.getByLabel('允许访问地址', { exact: true }).fill('https://example.test/path');
  await dialog.getByRole('button', { name: '检查更改' }).click();
  await expect(dialog.getByRole('alert')).toContainText('publicOrigin');
  await dialog.getByLabel('允许访问地址', { exact: true }).fill(origin);
  const other = await context.newPage();
  await open(other);
  await settings(other).getByLabel('请求超时（毫秒）', { exact: true }).fill('18000');
  await settings(other).getByRole('button', { name: '检查更改' }).click();
  await settings(other).getByRole('button', { name: '确认保存' }).click();
  await expect(settings(other).getByText('已保存，待重启生效', { exact: true })).toBeVisible();
  await page.bringToFront();
  await dialog.getByLabel('请求超时（毫秒）', { exact: true }).fill('19000');
  await dialog.getByRole('button', { name: '检查更改' }).click();
  await dialog.getByRole('button', { name: '确认保存' }).click();
  await expect(dialog.getByRole('alert')).toContainText('已被其他页面或程序修改');
  await dialog.getByRole('button', { name: '丢弃编辑并重新读取' }).click();
  await expect(dialog.getByLabel('请求超时（毫秒）', { exact: true })).toHaveValue('18000');
  await dialog.getByLabel('请求超时（毫秒）', { exact: true }).fill('20000');
  await dialog.getByRole('button', { name: '关闭服务配置' }).click();
  await expect(dialog.getByRole('region', { name: '放弃编辑确认' })).toBeVisible();
  await dialog.getByRole('button', { name: '继续编辑' }).click();
  await expect(dialog.getByLabel('请求超时（毫秒）', { exact: true })).toHaveValue('20000');
  await dialog.getByRole('button', { name: '关闭服务配置' }).click();
  await dialog.getByRole('button', { name: '放弃更改并关闭' }).click();
  await expect(dialog).not.toBeVisible();
});

test('Access fields and advanced limits validate together without changing the active listener', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await open(page);
  const dialog = settings(page);
  await dialog.getByLabel('认证模式', { exact: true }).selectOption('cloudflare-access');
  await dialog.getByLabel('监听地址', { exact: true }).fill('0.0.0.0');
  await dialog
    .getByLabel('Access 团队地址', { exact: true })
    .fill('https://team.cloudflareaccess.com');
  await dialog.getByLabel('Access 应用 AUD', { exact: true }).fill('example-application-aud');
  await dialog.getByLabel('允许访问地址', { exact: true }).fill('https://covro.example.test');
  await dialog.evaluate((node) => {
    node.scrollTop = 0;
  });
  await capture(page, info, 'gateway-settings-access');
  await dialog.getByText('高级设置', { exact: true }).click();
  await dialog.getByLabel('Codex 单行消息上限（字节）', { exact: true }).fill('33554432');
  await dialog.getByLabel('开发环境来源', { exact: true }).fill('https://foreign.test');
  await dialog.getByRole('button', { name: '检查更改' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Development origins must be loopback');
  await dialog.getByLabel('开发环境来源', { exact: true }).fill('http://localhost:5173');
  await dialog.getByRole('button', { name: '检查更改' }).click();
  await expect(dialog.getByRole('region', { name: '保存配置预览' })).toContainText('33554432');
  await dialog.getByRole('button', { name: '确认保存' }).click();
  await expect(dialog.getByText('已保存，待重启生效', { exact: true })).toBeVisible();
  expect((await page.request.get(`${origin}/api/system`)).ok()).toBe(true);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
    auth: { mode: 'cloudflare-access' },
    codex: { maxLineBytes: 33554432 },
  });
});
