import { expect, test } from '@playwright/test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'vite';
import config from '../../vite.config';

test('production build shares React with a renderer that has its own React copy', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-react-build-'));
  const require = createRequire(import.meta.url);
  const react = dirname(require.resolve('react/package.json'));
  const renderer = dirname(require.resolve('react-dom/package.json'));
  const rendererRequire = createRequire(join(renderer, 'package.json'));
  const modules = join(root, 'node_modules');
  const output = join(root, 'dist');
  try {
    await mkdir(modules);
    await cp(react, join(modules, 'react'), { recursive: true });
    await cp(renderer, join(modules, 'react-dom'), { recursive: true });
    // A copied/linked dependency can resolve a separate module instance even at the same version.
    await cp(react, join(modules, 'react-dom/node_modules/react'), { recursive: true });
    await cp(
      dirname(rendererRequire.resolve('scheduler/package.json')),
      join(modules, 'scheduler'),
      { recursive: true },
    );
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(
      join(root, 'index.html'),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    );
    await writeFile(
      join(root, 'main.tsx'),
      `import { useState } from 'react';
import { createRoot } from 'react-dom/client';
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}
createRoot(document.getElementById('root')!).render(<Counter />);
`,
    );
    await build({
      ...config,
      configFile: false,
      root,
      logLevel: 'silent',
      build: { outDir: output },
    });

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://react-build.test/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill({ path: join(output, path === '/' ? 'index.html' : path) });
    });
    await page.goto('http://react-build.test');
    const counter = page.getByRole('button', { name: 'Count: 0', exact: true });
    await expect.poll(async () => (await counter.count()) > 0 || errors.length > 0).toBe(true);
    expect(errors).toEqual([]);
    await expect(counter).toBeVisible();
    await counter.click();
    await expect(page.getByRole('button', { name: 'Count: 1', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
