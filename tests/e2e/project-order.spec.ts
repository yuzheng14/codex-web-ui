import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { parseConfig, type AppConfig } from '../../src/server/config';
import { startGateway } from '../../src/server/main';
import { DomainCodex } from '../integration/domain-helpers';

let directory: string;
let origin: string;
let config: AppConfig;
let runtime: Awaited<ReturnType<typeof startGateway>>;
let codex: DomainCodex;
const names = ['产品设计', '接口服务', '网页工作台'];

async function start() {
  runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
}
const order = (page: Page) => page.locator('.project-order-name');
const groups = (page: Page) => page.locator('.project-group[data-project-id]');
async function expectGroups(page: Page, expected: string[]) {
  await expect(groups(page)).toHaveCount(expected.length);
  expect(
    await groups(page).evaluateAll((elements) =>
      elements.map((el) => el.getAttribute('aria-label')),
    ),
  ).toEqual(expected);
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'covro-project-order-'));
  const projects = await Promise.all(
    names.map(async (name, index) => {
      const path = join(directory, `project-${index}`);
      await mkdir(path);
      return { id: `project-${index}`, name, path };
    }),
  );
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local port');
  await new Promise<void>((done) => probe.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  config = parseConfig(
    { port: address.port, publicOrigin: [origin], dataDir: join(directory, 'data'), projects },
    join(directory, 'config.json'),
  );
  config.demo = true;
  codex = new DomainCodex();
  codex.onStart = (id, turn) => setTimeout(() => codex.complete(id, turn.id), 50);
  await start();
});
test.afterEach(async () => {
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
});

test('desktop drag and keyboard ordering sync across tabs and survive navigation, refresh and restart', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin);
  await expectGroups(page, names);
  await page.screenshot({
    path: testInfo.outputPath('project-order-before-desktop.png'),
    animations: 'disabled',
  });
  const other = await context.newPage();
  await other.goto(origin);
  await expect(other.locator('.connection-badge')).toHaveText('实时连接正常');
  await page
    .getByRole('region', { name: '接口服务', exact: true })
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('验证项目排序保留会话');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
  const selected = await page
    .locator('[data-thread-id][aria-current="page"]')
    .getAttribute('data-thread-id');
  await page.getByRole('searchbox').fill('接口');
  await page.getByRole('button', { name: '调整项目顺序' }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(page.getByRole('searchbox')).toBeDisabled();
  await expect(order(page)).toHaveText(names);
  await page
    .locator('.project-order-row')
    .nth(2)
    .dragTo(page.locator('.project-order-row').nth(0), { targetPosition: { x: 30, y: 3 } });
  await expect(order(page)).toHaveText(['网页工作台', '产品设计', '接口服务']);
  await expect(page.getByRole('status').filter({ hasText: '顺序已保存' })).toBeVisible();
  const up = page.getByRole('button', { name: '上移项目 接口服务', exact: true });
  await up.focus();
  await up.press('Enter');
  const expected = ['网页工作台', '接口服务', '产品设计'];
  await expect(order(page)).toHaveText(expected);
  await expect(page.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
  await expectGroups(other, expected);
  await page.screenshot({
    path: testInfo.outputPath('project-order-desktop.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expectGroups(page, expected);
  await expect(page.locator('[data-thread-id][aria-current="page"]')).toHaveAttribute(
    'data-thread-id',
    selected!,
  );
  await page
    .getByRole('region', { name: '产品设计', exact: true })
    .getByRole('button', { name: '产品设计', exact: true })
    .click();
  await page
    .getByRole('region', { name: '接口服务', exact: true })
    .getByRole('button', { name: '接口服务', exact: true })
    .click();
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await expectGroups(page, expected);
  await page.locator(`[data-thread-id="${selected}"]`).click();
  await page.reload();
  await expectGroups(page, expected);
  await runtime.close();
  await start();
  await page.reload();
  await expectGroups(page, expected);
  await expect(page.locator('.user-text')).toHaveText('验证项目排序保留会话');
  await page.screenshot({
    path: testInfo.outputPath('project-order-after-desktop.png'),
    animations: 'disabled',
  });
});

test('failed saves are recoverable and stale project-list reads cannot overwrite a saved order', async ({
  page,
}) => {
  await page.goto(origin);
  await expectGroups(page, names);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  let releaseRead!: () => void;
  let fulfilledRead!: () => void;
  const fulfilled = new Promise<void>((done) => {
    fulfilledRead = done;
  });
  let startedRead!: () => void;
  const started = new Promise<void>((done) => {
    startedRead = done;
  });
  const released = new Promise<void>((done) => {
    releaseRead = done;
  });
  let holdRead = true;
  let failSave = true;
  await page.route(/\/api\/projects(?:\/reorder)?$/, async (route) => {
    if (route.request().method() === 'POST') {
      if (!failSave) return route.fallback();
      failSave = false;
      return route.fulfill({
        status: 500,
        json: { error: { code: 'INTERNAL_ERROR', message: 'Test save failed' } },
      });
    }
    if (!holdRead) return route.fallback();
    holdRead = false;
    const response = await route.fetch();
    startedRead();
    await released;
    await route.fulfill({ response });
    fulfilledRead();
  });
  await page.getByRole('button', { name: '刷新会话列表' }).click();
  await started;
  await page.getByRole('button', { name: '调整项目顺序' }).click();
  // Allow the error reconciliation read to finish independently of the old held response.
  await page.getByRole('button', { name: '下移项目 产品设计', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(order(page)).toHaveText(names);
  await page.getByRole('button', { name: '下移项目 产品设计', exact: true }).click();
  await expect(order(page)).toHaveText(['接口服务', '产品设计', '网页工作台']);
  await expect(page.getByRole('alert')).toHaveCount(0);
  releaseRead();
  await fulfilled;
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expectGroups(page, ['接口服务', '产品设计', '网页工作台']);
});

test.describe('touch sorting', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('mobile arrow controls reorder projects and persist after reloading', async ({
    page,
  }, testInfo) => {
    await page.goto(origin);
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await page.getByRole('button', { name: '调整项目顺序' }).tap();
    await expect(order(page)).toHaveText(names);
    await expect(
      page.getByRole('button', { name: '上移项目 产品设计', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '下移项目 网页工作台', exact: true }),
    ).toBeDisabled();
    const up = page.getByRole('button', { name: '上移项目 网页工作台', exact: true });
    await up.tap();
    await expect(order(page)).toHaveText(['产品设计', '网页工作台', '接口服务']);
    await expect(page.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
    await up.tap();
    const expected = ['网页工作台', '产品设计', '接口服务'];
    await expect(order(page)).toHaveText(expected);
    await expect(page.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
    const bounds = await page
      .getByRole('button', { name: '下移项目 网页工作台', exact: true })
      .boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(40);
    expect(bounds!.height).toBeGreaterThanOrEqual(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath('project-order-mobile.png'),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '完成', exact: true }).tap();
    await expectGroups(page, expected);
    await page.reload();
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await expectGroups(page, expected);
    await page.screenshot({
      path: testInfo.outputPath('project-order-after-mobile.png'),
      animations: 'disabled',
    });
  });
  test('sorting stays usable at 320px in every interface language with long project names', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.request.post(`${origin}/api/projects/project-0/rename`, {
      headers: { Origin: origin },
      data: { name: '产品设计 · 跨部门项目与多语言工作空间布局验证' },
    });
    await page.goto(origin);
    await page.getByRole('button', { name: '打开项目与会话' }).tap();
    await page.getByRole('button', { name: '调整项目顺序' }).tap();
    for (const [locale, title] of [
      ['en', 'Project order'],
      ['ja', 'プロジェクトの順序'],
      ['ko', '프로젝트 순서'],
      ['zh-Hans', '项目排序'],
    ]) {
      await page.locator('.language-selector select').selectOption(locale!);
      await expect(page.locator('.project-order-header h2')).toHaveText(title!);
      expect(
        await page.locator('.sidebar-toolbar').evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return [...element.querySelectorAll('button')].every((button) => {
            const box = button.getBoundingClientRect();
            return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
          });
        }),
        locale,
      ).toBe(true);
      const longName = order(page).first();
      expect(await longName.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  });
});
