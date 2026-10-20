import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: ['./tests/setup-i18n.ts'],
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
