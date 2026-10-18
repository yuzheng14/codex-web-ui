import { CODEX_COMPATIBILITY } from '../../src/codex/compatibility.js';
import { assessCodexCompatibility } from '../../src/shared/codex-compatibility.js';
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateStatus } from '../../src/shared/updates';
import { confirmCompatibility, controlRuntime } from './helpers';
const currentVersion = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const [major, minor] = currentVersion.split('.').map(Number);
const nextVersion = `${major}.${minor! + 1}.0`;
const developmentVersion = `${nextVersion}-dev.123`;

async function screenshot(page: Page, name: string) {
  if (!process.env.COVRO_SCREENSHOTS) return;
  await mkdir(process.env.COVRO_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.COVRO_SCREENSHOTS, name), fullPage: true });
}
async function updatesFixture(page: Page) {
  const state: UpdateStatus = {
    version: currentVersion,
    source: 'npm',
    codex: assessCodexCompatibility(CODEX_COMPATIBILITY, CODEX_COMPATIBILITY.recommended),
    supported: true,
    commit: '2a7c9d1e5432',
    settings: { channel: 'stable', automatic: false },
  };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let reload = false;
  await page.route('**/api/updates**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body =
      request.method() === 'POST' ? (request.postDataJSON() as Record<string, unknown>) : {};
    requests.push({ path, body });
    if (path.endsWith('/check'))
      state.available = {
        version: body.channel === 'dev' ? developmentVersion : nextVersion,
        channel: body.channel as 'dev' | 'stable',
        downgrade: false,
        commit: '8fb09cabcdef',
        codex: assessCodexCompatibility(CODEX_COMPATIBILITY, CODEX_COMPATIBILITY.recommended),
      };
    if (path.endsWith('/settings')) state.settings = body as unknown as UpdateStatus['settings'];
    if (path.endsWith('/run'))
      state.run = {
        id: String(body.clientOperationId),
        from: currentVersion,
        target: state.available!.version,
        channel: body.channel as 'dev',
        phase: 'waiting',
        message: '等待执行中的任务、审批或输入结束',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
    const result =
      reload && request.method() === 'GET' ? { ...state, version: nextVersion } : state;
    reload = false;
    await route.fulfill({ json: result });
  });
  return {
    state,
    requests,
    triggerReload: () => {
      reload = true;
    },
  };
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name}: channel, automatic updates and persistent waiting/rollback results`, async ({
    page,
  }) => {
    const fixture = await updatesFixture(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await confirmCompatibility(page);
    if (viewport.name === 'mobile')
      await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
    await page.getByRole('button', { name: 'Covro 更新', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Covro 更新', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: '版本渠道' }).selectOption('dev');
    await expect(dialog).toContainText(developmentVersion);
    await dialog.getByRole('switch', { name: '空闲时自动升级' }).click();
    await expect(dialog.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await screenshot(page, `update-${viewport.name}-available.png`);
    await dialog.getByRole('button', { name: '升级并重启', exact: true }).click();
    await expect(dialog).toContainText('等待任务空闲');
    expect(fixture.requests.filter((request) => request.path.endsWith('/run'))).toHaveLength(1);
    await screenshot(page, `update-${viewport.name}-waiting.png`);
    fixture.state.run = {
      ...fixture.state.run!,
      phase: 'rolledBack',
      message: '新版启动验证失败，已恢复上一版本，配置和操作记录保持完整',
    };
    await expect(dialog).toContainText('已恢复上一版本', { timeout: 10_000 });
    await screenshot(page, `update-${viewport.name}-rollback.png`);
    expect(fixture.requests.filter((request) => request.path.endsWith('/run'))).toHaveLength(1);
    if (viewport.name === 'mobile')
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
  });
}

test('new server version reloads the UI once and restores the tab draft and pasted image without submitting it', async ({
  page,
}) => {
  const fixture = await updatesFixture(page);
  let submissions = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(turns|steer)$/.test(new URL(request.url()).pathname))
      submissions++;
  });
  await page.goto('/');
  await confirmCompatibility(page);
  const input = page.locator('.composer-box textarea');
  await expect(input).toBeEnabled();
  await input.fill('升级后继续处理这份草稿，保留图片。');
  await input.evaluate((element) => {
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      ),
      (value) => value.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'draft.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator('.composer-images img')).toHaveCount(1);
  const loaded = page.waitForEvent('load');
  fixture.triggerReload();
  await loaded;
  await expect(input).toHaveValue('升级后继续处理这份草稿，保留图片。');
  await expect(page.locator('.composer-images img')).toHaveCount(1);
  expect(submissions).toBe(0);
});
