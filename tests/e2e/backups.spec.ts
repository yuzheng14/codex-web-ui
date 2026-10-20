import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/server/config';
import { startGateway } from '../../src/server/main';
import type { BackupManager } from '../../src/backups/manager';
import { DomainCodex } from '../integration/domain-helpers';

let root: string, config: string, origin: string;
let runtime: Awaited<ReturnType<typeof startGateway>>;
let codex: DomainCodex;
const dialog = (page: Page) => page.getByRole('dialog', { name: '备份与恢复', exact: true });
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'covro-backup-browser-'));
  config = join(root, 'config.json');
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  await new Promise<void>((done) => probe.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    config,
    JSON.stringify({
      port: address.port,
      publicOrigin: [origin],
      dataDir: './data',
      projects: [{ id: 'project', name: 'Backup verification', path: root }],
    }),
  );
  codex = new DomainCodex();
  runtime = await startGateway(await loadConfig({ configPath: config, development: false }), {
    codex,
    staticDir: resolve('dist/web'),
  });
  (runtime.backups as BackupManager).store.options.directory = join(root, 'backups');
});
test.afterEach(async () => {
  await runtime?.close();
  await rm(root, { recursive: true, force: true });
});
async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled', fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
  if (process.env.COVRO_SCREENSHOTS) {
    await mkdir(process.env.COVRO_SCREENSHOTS, { recursive: true });
    await page.screenshot({
      path: join(process.env.COVRO_SCREENSHOTS, `${name}.png`),
      animations: 'disabled',
      fullPage: true,
    });
  }
}
for (const viewport of [
  { name: 'desktop', width: 1440, height: 1100 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name}: actual manual backup waits, succeeds, verifies and reports invalid configuration`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(origin);
    if (viewport.name === 'mobile')
      await page.getByRole('button', { name: '打开项目与会话' }).click();
    await expect(page.getByRole('button', { name: '备份与恢复', exact: true })).toBeVisible();
    await capture(page, info, `backup-${viewport.name}-entry`);
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
    await expect(
      dialog(page).getByText('还没有备份。创建第一份快照，或在升级前自动创建。'),
    ).toBeVisible();
    await capture(page, info, `backup-${viewport.name}-empty`);
    const created = await runtime.service.createThread('project', {
      clientOperationId: randomUUID(),
    });
    const threadId = (created.result as { threadId: string }).threadId;
    const turn = await runtime.service.startTurn(threadId, {
      clientOperationId: randomUUID(),
      text: 'A running task',
    });
    await dialog(page).getByRole('button', { name: '立即备份', exact: true }).click();
    const progress = dialog(page).getByRole('status', { name: '备份进度' });
    await expect(progress).toContainText('等待安全点');
    await expect(
      dialog(page).getByRole('button', { name: '立即备份', exact: true }),
    ).toBeDisabled();
    await capture(page, info, `backup-${viewport.name}-waiting`);
    codex.complete(threadId, turn.execution!.turnId!);
    await expect(dialog(page).locator('.backup-record[data-phase="succeeded"]')).toHaveCount(1);
    await expect(progress).toHaveCount(0);
    await expect(dialog(page)).toContainText('Schema 5');
    await capture(page, info, `backup-${viewport.name}-success`);
    await dialog(page).getByRole('button', { name: '重新验证', exact: true }).click();
    await expect(dialog(page)).toContainText('备份已重新验证，可按当前版本的恢复流程使用。');
    await dialog(page).getByText('恢复方式', { exact: true }).click();
    await expect(dialog(page).locator('.backup-restore code')).toContainText(
      'covro backup restore',
    );
    await writeFile(config, 'invalid configuration');
    await dialog(page).getByRole('button', { name: '立即备份', exact: true }).click();
    await expect(dialog(page).locator('.backup-record[data-phase="failed"]')).toHaveCount(1);
    await expect(dialog(page).getByRole('alert')).toContainText('服务配置无效');
    await expect(dialog(page).locator('.backup-record[data-phase="succeeded"]')).toHaveCount(1);
    await dialog(page).evaluate((node) => {
      node.scrollTop = 0;
    });
    await capture(page, info, `backup-${viewport.name}-failure`);
    expect(await dialog(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await dialog(page).getByRole('button', { name: '关闭备份与恢复' }).click();
    await expect(dialog(page)).toHaveCount(0);
  });
}
