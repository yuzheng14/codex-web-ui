import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmCompatibility, controlRuntime, createEmptyThread } from './helpers';

const attachment =
  'https://github.com/user-attachments/assets/04aaa811-cdeb-45e0-a303-0619761552f1';
let redirected: string;
let redirectRequests = 0;
const evidence = join(tmpdir(), 'codex-issue-122-evidence');
// Deterministic upstream bytes; the actual page, Markdown renderer, gateway and CSP run normally.
const picture = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#edf5f0"/>
  <text x="48" y="80" font-family="sans-serif" font-size="38" fill="#1f4b3c">Remote image preview</text>
  <rect x="48" y="130" width="864" height="340" rx="18" fill="white"/>
  <path d="M100 400L290 280L470 330L670 200L850 170" fill="none" stroke="#4b8b69" stroke-width="12"/>
</svg>`;
// A real HTTPS target verifies the browser's redirect/CSP behavior without Internet access.
// This checked-in certificate/key is exclusively a disposable test fixture.
test.use({ ignoreHTTPSErrors: true });
let upstream: ReturnType<typeof createServer>;
test.beforeAll(async () => {
  const tls = await readFile(new URL('../fixtures/remote-images.test.pem', import.meta.url));
  upstream = createServer({ key: tls, cert: tls }, (_request, response) => {
    redirectRequests++;
    response.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(picture);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Expected HTTPS fixture port');
  redirected = `https://127.0.0.1:${address.port}/render?id=preview&signature=test`;
});
test.afterAll(async () => {
  upstream?.closeAllConnections();
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
const reply = (page: Page) => page.getByRole('article', { name: 'Codex 的回复' });
const dialog = (page: Page) => page.getByRole('dialog', { name: '图片预览', exact: true });
const thumbnail = (page: Page, alt: string) =>
  reply(page).getByRole('img', { name: alt, exact: true });

async function send(page: Page, prompt = '[remote-images] 请展示远程图片') {
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.turn-heading .status').last()).toHaveText('已完成');
}

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' });
}

test.beforeEach(async ({ page, request }) => {
  redirectRequests = 0;
  await controlRuntime(request, { reset: true });
  await mkdir(evidence, { recursive: true });
  await page.route('https://**/*', async (route) => {
    if (route.request().url().startsWith('https://images.example.test/asset?')) {
      await route.fulfill({ status: 302, headers: { Location: redirected } });
    } else {
      await route.fulfill({ contentType: 'image/svg+xml', body: picture });
    }
  });
  await page.setViewportSize({ width: 1280, height: 980 });
  const response = await page.goto('/');
  const csp = response!.headers()['content-security-policy']!;
  expect(csp).toContain("img-src 'self' data: blob: https:;");
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ]) {
    expect(csp.split(';').map((value) => value.trim())).toContain(directive);
  }
  await confirmCompatibility(page);
  await createEmptyThread(page);
});

test('gateway CSP permits extensionless HTTPS images, queries and cross-origin redirects', async ({
  page,
}) => {
  const requests: string[] = [];
  const referrers: (string | undefined)[] = [];
  const violations: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
    if (request.resourceType() === 'image') referrers.push(request.headers()['referer']);
  });
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) violations.push(message.text());
  });
  await send(page);
  for (const alt of ['桌面复制效果', '跨域跳转图片', '带链接的图片']) {
    await expect(thumbnail(page, alt)).toHaveJSProperty('naturalWidth', 960);
  }
  expect(requests).toContain(attachment);
  expect(requests).toContain('https://images.example.test/asset?name=preview&version=2');
  expect(requests).toContain(redirected);
  expect(redirectRequests).toBeGreaterThan(0);
  expect(requests.some((url) => url.includes('/images?path='))).toBe(false);
  expect(referrers.length).toBeGreaterThanOrEqual(3);
  expect(referrers.every((value) => value === undefined)).toBe(true);
  expect(violations).toEqual([]);
  await thumbnail(page, '桌面复制效果').scrollIntoViewIfNeeded();
  await screenshot(page, 'desktop-inline');
  const open = reply(page).getByRole('button', { name: '预览图片：桌面复制效果', exact: true });
  await open.press('Enter');
  await expect(dialog(page).getByRole('img')).toHaveJSProperty('naturalWidth', 960);
  await expect(dialog(page).getByRole('link', { name: '打开原图' })).toHaveAttribute(
    'href',
    attachment,
  );
  await page.getByRole('button', { name: '放大图片', exact: true }).click();
  await expect(dialog(page)).toContainText('125%');
  await screenshot(page, 'desktop-preview');
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
  const linked = thumbnail(page, '带链接的图片').locator('..').locator('..').locator('..');
  await expect(linked).toHaveAttribute('href', 'https://example.com/docs');
  await expect(linked.locator('button, a')).toHaveCount(0);
  await page.reload();
  await expect(thumbnail(page, '桌面复制效果')).toHaveJSProperty('naturalWidth', 960);
});

for (const width of [320, 390]) {
  test(`${width}px thumbnails and zoom preview stay within the viewport`, async ({ page }) => {
    await send(page);
    await page.setViewportSize({ width, height: 844 });
    await thumbnail(page, '桌面复制效果').scrollIntoViewIfNeeded();
    await expect(thumbnail(page, '桌面复制效果')).toHaveJSProperty('naturalWidth', 960);
    const box = await thumbnail(page, '桌面复制效果').boundingBox();
    expect(box!.width).toBeLessThan(width);
    expect(box!.height).toBeLessThanOrEqual(280);
    await screenshot(page, `mobile-${width}-inline`);
    const open = reply(page).getByRole('button', { name: '预览图片：桌面复制效果', exact: true });
    await open.press('Enter');
    await expect(dialog(page).getByRole('img')).toHaveJSProperty('naturalWidth', 960);
    await page.keyboard.press('+');
    await expect(dialog(page)).toContainText('125%');
    await screenshot(page, `mobile-${width}-preview`);
    await page.keyboard.press('0');
    await expect(dialog(page)).toContainText('100%');
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
  });
}

test('missing, denied, offline and corrupt images offer original links and recover on retry', async ({
  page,
}) => {
  let recovered = false;
  await page.route('https://images.example.test/**', async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (recovered) await route.fulfill({ contentType: 'image/svg+xml', body: picture });
    else if (name === 'offline') await route.abort('internetdisconnected');
    else
      await route.fulfill({
        status: name === 'missing' ? 404 : name === 'refused' ? 403 : 200,
        contentType: 'image/png',
        body: 'invalid image',
      });
  });
  await send(page, '[remote-image-errors] 请检查图片');
  await expect(reply(page).getByRole('alert')).toHaveCount(4);
  for (const name of ['missing', 'refused', 'offline', 'corrupt']) {
    const error = reply(page)
      .getByRole('alert')
      .filter({ hasText: `https://images.example.test/${name}` });
    await expect(error).toContainText('图片加载失败');
    await expect(error.getByRole('link', { name: '打开原图' })).toHaveAttribute(
      'href',
      `https://images.example.test/${name}`,
    );
    await expect(error.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  }
  await reply(page).scrollIntoViewIfNeeded();
  await screenshot(page, 'desktop-errors');
  recovered = true;
  for (const name of ['missing', 'refused', 'offline', 'corrupt']) {
    await reply(page)
      .getByRole('alert')
      .filter({ hasText: `https://images.example.test/${name}` })
      .getByRole('button', { name: '重试加载图片' })
      .click();
    await expect(thumbnail(page, name)).toHaveJSProperty('naturalWidth', 960);
  }
  await expect(reply(page).getByRole('alert')).toHaveCount(0);
});

test('a preview failure keeps the original URL and supports retry', async ({ page }) => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(attachment, async (route) => {
    await pending;
    await route.abort('failed');
  });
  await send(page);
  await reply(page).getByRole('button', { name: '预览图片：桌面复制效果', exact: true }).click();
  release();
  await expect(dialog(page).getByRole('alert')).toContainText(attachment);
  await expect(dialog(page).getByRole('alert').getByRole('link')).toHaveAttribute(
    'href',
    attachment,
  );
  await page.unroute(attachment);
  await dialog(page).getByRole('button', { name: '重试加载图片' }).click();
  await expect(dialog(page).getByRole('img')).toHaveJSProperty('naturalWidth', 960);
});
