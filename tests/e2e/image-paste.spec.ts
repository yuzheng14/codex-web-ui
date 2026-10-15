import { expect, test, type Page } from '@playwright/test';
import { confirmCompatibility, controlRuntime, createThreadButton } from './helpers';

const input = (page: Page) => page.locator('.composer-box textarea');
const previews = (page: Page) => page.locator('.composer-images img');
const send = (page: Page) => page.getByRole('button', { name: '发送任务', exact: true });
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

async function openThread(page: Page) {
  await page.goto('/');
  await confirmCompatibility(page);
  await createThreadButton(page).click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  return (await page.evaluate(() => localStorage.getItem('codex-web.selected:fixture')))!;
}

async function pasteFiles(page: Page, count = 1, type = 'image/png', size?: number, text = '') {
  await input(page).evaluate(
    (element, args) => {
      const data = new DataTransfer();
      const bytes =
        args.size === undefined
          ? Uint8Array.from(atob(args.png), (c) => c.charCodeAt(0))
          : new Uint8Array(args.size);
      for (let i = 0; i < args.count; i++)
        data.items.add(new File([bytes], `image-${i + 1}.png`, { type: args.type }));
      if (args.text) data.setData('text/plain', args.text);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { count, type, size, text, png },
  );
}

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name}: native clipboard images preview, send and survive history reload`, async ({
    page,
    context,
  }) => {
    await openThread(page);
    await page.setViewportSize(viewport);
    if (viewport.name === 'mobile') await expect(page.locator('.sidebar')).not.toBeInViewport();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 520;
      canvas.height = 300;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ecf4ee';
      ctx.fillRect(0, 0, 520, 300);
      ctx.fillStyle = '#234b39';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText('Project overview', 28, 48);
      const labels = ['Design', 'Develop', 'Review'];
      labels.forEach((label, i) => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(28 + i * 164, 80, 145, 180);
        ctx.fillStyle = '#3f7757';
        ctx.font = '18px sans-serif';
        ctx.fillText(label, 40 + i * 164, 112);
        ctx.fillStyle = '#b9d8c2';
        ctx.fillRect(40 + i * 164, 138, 120, 16);
        ctx.fillRect(40 + i * 164, 170, 90, 16);
      });
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), 'image/png'),
      );
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    });
    if (viewport.name === 'desktop') await input(page).fill('看看这张页面截图，帮我调整一下布局。');
    await input(page).focus();
    await input(page).press('ControlOrMeta+V');
    await expect(previews(page)).toHaveCount(1);
    await expect(previews(page)).toHaveJSProperty('naturalWidth', 520);
    await expect(send(page)).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/private/tmp/paste-images-${viewport.name}-draft.png`,
      fullPage: true,
      animations: 'disabled',
    });
    const outgoing = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/turns'),
    );
    await input(page).press('Enter');
    const body = (await outgoing).postDataJSON();
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(body.text).toBe(
      viewport.name === 'desktop' ? '看看这张页面截图，帮我调整一下布局。' : '',
    );
    await expect(previews(page)).toHaveCount(0);
    await expect(page.locator('.message-images img')).toHaveJSProperty('naturalWidth', 520);
    await expect(page.locator('.turn-heading .status')).toHaveText('已完成');
    await page.reload();
    await expect(page.locator('.message-images img')).toHaveJSProperty('naturalWidth', 520);
    await page.screenshot({
      path: `/private/tmp/paste-images-${viewport.name}-sent.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });
}

test('multiple images can be removed, remain isolated by thread and retain accompanying text', async ({
  page,
}) => {
  const first = await openThread(page);
  await input(page).fill('before after');
  await input(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(7, 7));
  await pasteFiles(page, 2, 'image/png', undefined, '粘贴文字 ');
  await expect(previews(page)).toHaveCount(2);
  await expect(input(page)).toHaveValue('before 粘贴文字 after');
  await page.getByRole('button', { name: '移除图片 1', exact: true }).click();
  await expect(previews(page)).toHaveCount(1);
  await createThreadButton(page).click();
  await expect(input(page)).toHaveValue('');
  await expect(previews(page)).toHaveCount(0);
  await page.locator(`[data-thread-id="${first}"]`).click();
  await expect(previews(page)).toHaveCount(1);
  await expect(input(page)).toHaveValue('before 粘贴文字 after');
});

test('unsupported, empty, oversized and excess images leave the draft intact', async ({ page }) => {
  await openThread(page);
  await input(page).fill('原有文字');
  await pasteFiles(page);
  await expect(previews(page)).toHaveCount(1);
  for (const sample of [
    { count: 1, type: 'image/svg+xml', size: 20, error: 'PNG、JPEG' },
    { count: 1, type: 'image/png', size: 0, error: '图片为空' },
    { count: 1, type: 'image/png', size: 2 * 1024 * 1024, error: '2 MiB' },
    { count: 4, type: 'image/png', size: undefined, error: '最多添加 4 张' },
  ]) {
    await pasteFiles(page, sample.count, sample.type, sample.size);
    await expect(page.locator('.composer-image-error')).toContainText(sample.error);
    await expect(previews(page)).toHaveCount(1);
    await expect(input(page)).toHaveValue('原有文字');
  }
});

test('failed and uncertain sends preserve images; only acknowledged attachments clear', async ({
  page,
}) => {
  await openThread(page);
  await pasteFiles(page);
  let release!: () => void;
  let status = 400;
  let code = 'CODEX_RPC_ERROR';
  await page.route('**/api/threads/*/turns', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ status, json: { error: { code, message: '测试图片发送失败' } } });
  });
  await send(page).click();
  await expect(page.getByRole('button', { name: '正在提交…' })).toBeDisabled();
  release();
  await expect(send(page)).toBeEnabled();
  await expect(previews(page)).toHaveCount(1);
  status = 409;
  code = 'RESULT_UNKNOWN';
  await send(page).click();
  await expect(page.getByRole('button', { name: '正在提交…' })).toBeDisabled();
  release();
  await expect(page.locator('.pending-notice')).toBeVisible();
  await expect(send(page)).toBeDisabled();
  await expect(previews(page)).toHaveCount(1);
});

test('images pasted while a send is in flight remain in the next draft', async ({ page }) => {
  await openThread(page);
  await pasteFiles(page);
  let release!: () => void;
  await page.route('**/api/threads/*/turns', async (route) => {
    const response = await route.fetch();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
  });
  await send(page).click();
  await expect(page.getByRole('button', { name: '正在提交…' })).toBeDisabled();
  await pasteFiles(page);
  await input(page).fill('下一条消息');
  await expect(previews(page)).toHaveCount(2);
  await expect.poll(() => typeof release).toBe('function');
  release();
  await expect(previews(page)).toHaveCount(1);
  await expect(input(page)).toHaveValue('下一条消息');
});

test('pending reads block Enter and finish in the originating draft after switching threads', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob) {
      setTimeout(() => original.call(this, blob), 600);
    };
  });
  const first = await openThread(page);
  await input(page).fill('等图片读完');
  await pasteFiles(page);
  await expect(page.locator('.composer-images')).toContainText('读取中');
  await expect(send(page)).toBeDisabled();
  await input(page).press('Enter');
  await createThreadButton(page).click();
  await expect(previews(page)).toHaveCount(0);
  await page.locator(`[data-thread-id="${first}"]`).click();
  await expect(previews(page)).toHaveCount(1);
  await expect(input(page)).toHaveValue('等图片读完');
  await expect(page.locator('.turn')).toHaveCount(0);
});

test('an image-only follow-up steers the current turn', async ({ page }) => {
  await openThread(page);
  await input(page).fill('[approval] 等待追加图片');
  await input(page).press('Enter');
  await expect(page.locator('.action-card')).toBeVisible();
  await pasteFiles(page);
  const outgoing = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/steer'));
  await input(page).press('Enter');
  const body = (await outgoing).postDataJSON();
  expect(body.text).toBe('');
  expect(body.images).toHaveLength(1);
  await expect(previews(page)).toHaveCount(0);
  await expect(page.locator('.message-images img')).toHaveCount(1);
  await expect(page.locator('.turn')).toHaveCount(1);
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(page.locator('.turn-heading .status')).toHaveText('已中断');
});
