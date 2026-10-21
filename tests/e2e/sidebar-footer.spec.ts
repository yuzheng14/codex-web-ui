import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { supportedLocales } from '../../src/web/i18n/locales';
import { confirmCompatibility, controlRuntime, openSidebarSettings } from './helpers';

test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const locale of supportedLocales) {
  const catalog = (namespace: string): Record<string, string> =>
    JSON.parse(readFileSync(`src/web/i18n/locales/${locale}/${namespace}.json`, 'utf8'));
  const sidebar = catalog('sidebar');
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    test(`${locale} ${viewport.width}px: compact footer and usable settings`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((value) => localStorage.setItem('covro.locale', value), locale);
      await page.goto('/');
      await page.locator('.compatibility-dialog-actions button').last().click();
      if (viewport.width < 760) await page.locator('.topbar .mobile-only').click();
      const footer = page.locator('.sidebar-footer');
      const trigger = footer.getByRole('button', { name: sidebar.settings, exact: true });
      await expect(trigger).toBeVisible();
      await expect(footer.getByRole('button')).toHaveCount(1);
      await expect(footer).toContainText(sidebar.runs_on_server!);
      await expect(footer).not.toContainText(
        sidebar.code_and_credentials_stay_on_the_computer_running!,
      );
      const metrics = await footer.evaluate((element) => {
        const button = element.querySelector('button')!.getBoundingClientRect();
        return {
          height: element.getBoundingClientRect().height,
          overflow: element.scrollWidth > element.clientWidth,
          buttonWidth: button.width,
          buttonHeight: button.height,
        };
      });
      expect(metrics.height).toBeLessThanOrEqual(52);
      expect(metrics.overflow).toBe(false);
      expect(metrics.buttonWidth).toBeGreaterThanOrEqual(36);
      expect(metrics.buttonHeight).toBeGreaterThanOrEqual(36);
      await page.screenshot({ path: info.outputPath('footer.png'), animations: 'disabled' });

      // The settings overview owns the low-frequency copy and labels every original entry.
      const dialog = await openSidebarSettings(page);
      await expect(dialog.getByRole('combobox', { name: catalog('common').language })).toHaveValue(
        locale,
      );
      await expect(
        dialog.getByRole('button', { name: catalog('common').service_settings, exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: catalog('backups').title, exact: true }),
      ).toBeVisible();
      await expect(dialog.locator('.sidebar-settings-status')).not.toBeEmpty();
      await expect(dialog).toContainText(
        sidebar.code_and_credentials_stay_on_the_computer_running!,
      );
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      for (const button of await dialog.locator('.sidebar-settings-links button').all()) {
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: info.outputPath('settings.png'), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await trigger.press('Enter');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: catalog('common').close, exact: true }).click();
      await expect(trigger).toBeFocused();
    });
  }
}

test('opening notification settings closes the overview and restores the footer focus', async ({
  page,
}) => {
  await page.goto('/');
  await confirmCompatibility(page);
  const settings = await openSidebarSettings(page);
  const status = await settings.locator('.sidebar-settings-status').textContent();
  await settings.getByRole('button', { name: `工作完成通知 · ${status}` }).click();
  await expect(settings).not.toBeVisible();
  const notifications = page.getByRole('dialog', { name: '工作完成通知', exact: true });
  await expect(notifications).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notifications).not.toBeVisible();
  await expect(page.locator('.sidebar-settings-trigger')).toBeFocused();
});
