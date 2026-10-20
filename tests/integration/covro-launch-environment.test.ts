import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { environmentBridge, launchRunner } from '../../src/cli/launch-environment.js';

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.skipIf(process.platform === 'win32')(
  'passes environment and cwd in memory and execs an unmodified legacy entry',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'c188-env-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    vi.stubEnv('COVRO_TEST_SECRET', 'fake-secret-188');
    const bridge = await environmentBridge(root);
    cleanups.push(bridge.close);
    expect((await stat(bridge.path)).mode & 0o777).toBe(0o600);
    const runner = join(root, 'runner.mjs');
    const entry = join(root, 'legacy entry.mjs');
    await writeFile(runner, launchRunner);
    await writeFile(
      entry,
      `console.log(JSON.stringify({ secretInherited: process.env.COVRO_TEST_SECRET === 'fake-' + 'secret-188', cwd: process.cwd(), home: process.env.COVRO_HOME, args: process.argv.slice(2) }));`,
    );
    const config = join(root, 'config & test.json');
    const child = exec(process.execPath, [runner, bridge.path, entry, config], {
      env: { PATH: process.env.PATH },
    });
    await bridge.wait();
    const result = JSON.parse((await child).stdout);
    expect(result).toEqual({
      secretInherited: true,
      cwd: process.cwd(),
      home: root,
      args: ['run', '--config', config],
    });
    for (const name of await readdir(root)) {
      if (name.endsWith('.mjs'))
        expect(await readFile(join(root, name), 'utf8')).not.toContain('fake-secret-188');
    }
  },
);
