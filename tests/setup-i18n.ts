import { expect } from 'vitest';

// Existing web regression fixtures exercise the original Chinese UI explicitly.
// Backend tests do not load the browser resource catalogs.
if (expect.getState().testPath?.includes('/tests/web/')) {
  const { i18n } = await import('../src/web/i18n');
  await i18n.changeLanguage('zh-Hans');
}
