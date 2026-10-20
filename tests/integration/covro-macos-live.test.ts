import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { launchdPaths } from '../../src/cli/launchd.js';
import { startBackground, stopBackground } from '../../src/cli/background.js';
import { paths } from '../../src/cli/paths.js';

const exec = promisify(execFile);

// Explicit opt-in: requires a real logged-in macOS desktop and a local production build.
it.runIf(process.platform === 'darwin' && process.env.COVRO_TEST_LAUNCHD === '1')(
  'runs the built CLI through GUI launchd, keeps environment private, restarts and switches login mode',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'c188-live-'));
    const home = join(root, 'h');
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    await new Promise<void>((done) => listener.close(() => done()));
    const config = join(root, 'config & desktop.json');
    await writeFile(
      config,
      JSON.stringify({
        port: address.port,
        publicOrigin: [`http://127.0.0.1:${address.port}`],
        dataDir: './data',
        codex: { binary: join(root, 'missing-codex') },
      }),
    );
    const entry = resolve('bin/covro.mjs');
    const env = {
      ...process.env,
      COVRO_HOME: home,
      GH_TOKEN: 'fake-private-token-188',
      GITHUB_TOKEN: '',
    };
    const cli = (...args: string[]) =>
      exec(process.execPath, [entry, ...args, '--config', config], {
        env,
        cwd: root,
        timeout: 75000,
      });
    const otherListener = createServer().listen(0, '127.0.0.1');
    await once(otherListener, 'listening');
    const otherAddress = otherListener.address();
    if (!otherAddress || typeof otherAddress === 'string') throw new Error('Expected TCP address');
    await new Promise<void>((done) => otherListener.close(() => done()));
    const otherConfig = join(root, 'other.json');
    await writeFile(
      otherConfig,
      JSON.stringify({
        port: otherAddress.port,
        publicOrigin: [`http://127.0.0.1:${otherAddress.port}`],
        dataDir: './other-data',
        codex: { binary: join(root, 'missing-codex') },
      }),
    );
    const otherCli = (...args: string[]) =>
      exec(process.execPath, [entry, ...args, '--config', otherConfig], {
        env,
        cwd: root,
        timeout: 75000,
      });
    // Resolve paths without changing the test runner's environment.
    const location = paths(config);
    location.home = home;
    location.state = join(home, 'instances', location.key);
    location.socket = join(home, `c-${location.key}.sock`);
    location.log = join(location.state, 'covro.log');
    const files = launchdPaths(location);
    const loginFiles = launchdPaths(location, `dev.covro.${location.key}`);
    try {
      const starts = await Promise.all([cli('start'), cli('start')]);
      const first = JSON.parse(starts[0]!.stdout);
      expect(JSON.parse(starts[1]!.stdout).pid).toBe(first.pid);
      await expect(exec('/bin/launchctl', ['print', files.target])).resolves.toBeDefined();
      expect(await readFile(files.temporary, 'utf8')).not.toContain(env.GH_TOKEN);
      await expect(readFile(loginFiles.login)).rejects.toMatchObject({ code: 'ENOENT' });
      const other = JSON.parse((await otherCli('start')).stdout);
      await cli('stop');
      expect(JSON.parse((await otherCli('status')).stdout).pid).toBe(other.pid);
      await expect(exec('/bin/launchctl', ['print', files.target])).rejects.toBeDefined();
      const second = JSON.parse((await cli('start')).stdout);
      expect(second.pid).not.toBe(first.pid);
      // The same functions are bundled into the updater for activation, rollback and repair.
      await stopBackground(location);
      const restored = (await startBackground(location, entry)) as {
        pid: number;
      };
      expect(restored.pid).toBeGreaterThan(0);
      await cli('service', 'install');
      await cli('service', 'install');
      expect(await readFile(loginFiles.login, 'utf8')).toContain('<string>Aqua</string>');
      expect(await readFile(loginFiles.login, 'utf8')).not.toContain(env.GH_TOKEN);
      await cli('stop');
      const loginRestart = JSON.parse((await cli('start')).stdout);
      expect(loginRestart.pid).toBeGreaterThan(0);
      await cli('service', 'uninstall');
      await cli('service', 'uninstall');
      await expect(readFile(loginFiles.login)).rejects.toMatchObject({ code: 'ENOENT' });
      await cli('start');
      await cli('stop');
      expect((await readFile(join(root, 'data/app.sqlite'))).length).toBeGreaterThan(0);
    } finally {
      await otherCli('stop').catch(() => {});
      await cli('service', 'uninstall').catch(() => {});
      await cli('stop').catch(() => {});
      await exec('/bin/launchctl', ['bootout', files.target]).catch(() => {});
      await exec('/bin/launchctl', ['bootout', loginFiles.target]).catch(() => {});
      await rm(loginFiles.login, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
