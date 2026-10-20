import { spawn, execFile } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import type { CovroPaths } from './paths.js';
import { control, isNotRunning, stopAndWait } from './control.js';
import {
  configureLaunchdLogin,
  guiSessionAvailable,
  loginServiceInstalled,
  startLaunchd,
  unloadLaunchd,
} from './launchd.js';
import { readJson } from '../updates/files.js';

const exec = promisify(execFile);
async function lifecycle<T>(location: CovroPaths, action: () => Promise<T>) {
  await mkdir(location.state, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(location.state, {
    lockfilePath: join(location.state, 'lifecycle.lock'),
    stale: 10_000,
    update: 2_000,
    retries: { retries: 280, minTimeout: 250, maxTimeout: 250 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

async function start(location: CovroPaths, entry: string) {
  try {
    return await control(location, 'status');
  } catch (error) {
    if (!isNotRunning(error)) throw error;
  }
  let child: ReturnType<typeof spawn> | undefined;
  const installed = await readJson<{ platform: string; label: string }>(
    join(location.state, 'service.json'),
  );
  if (process.platform === 'darwin' && (await startLaunchd(location, entry))) {
    // launchd owns the process; startup is confirmed through the same private control socket.
  } else if (installed?.platform === 'linux') {
    await exec('systemctl', ['--user', 'start', `${installed.label}.service`]);
  } else {
    if (process.platform === 'darwin')
      console.warn(
        '当前没有 macOS 桌面登录会话，使用 headless 后台启动；系统钥匙串凭证可能不可用。',
      );
    const log = await open(location.log, 'a', 0o600);
    try {
      child = spawn(process.execPath, [entry, 'run', '--config', location.config], {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        windowsHide: true,
        env: { ...process.env, COVRO_HOME: location.home },
      });
      await new Promise<void>((resolve, reject) => {
        child!.once('spawn', resolve);
        child!.once('error', reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
  }
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      return await control(location, 'status');
    } catch (error) {
      if (!isNotRunning(error)) throw error;
    }
    if (child && child.exitCode !== null) throw new Error(`Covro 启动失败，请查看 ${location.log}`);
    await setTimeout(250);
  }
  throw new Error(`Covro 尚未确认启动，请运行 covro status 并查看 ${location.log}`);
}

async function stop(location: CovroPaths) {
  await stopAndWait(location);
  if (process.platform === 'darwin') await unloadLaunchd(location);
  else {
    const installed = await readJson<{ platform: string; label: string }>(
      join(location.state, 'service.json'),
    );
    if (installed?.platform === 'linux')
      await exec('systemctl', ['--user', 'stop', `${installed.label}.service`]);
  }
}

export const startBackground = (location: CovroPaths, entry: string) =>
  lifecycle(location, () => start(location, entry));
export const stopBackground = (location: CovroPaths) => lifecycle(location, () => stop(location));
export const macOSLoginService = (location: CovroPaths, entry: string, install: boolean) =>
  lifecycle(location, async () => {
    if (install && !(await guiSessionAvailable(location)))
      throw new Error('启用登录自启需要当前用户已登录 macOS 桌面');
    if (!install && !(await loginServiceInstalled(location))) return;
    await stop(location);
    await configureLaunchdLogin(location, entry, install);
    if (install) await start(location, entry);
  });
