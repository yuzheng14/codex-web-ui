import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { control, isNotRunning } from './control.js';
import { ensureConfig, packageInfo, packageRoot, paths, type CovroPaths } from './paths.js';
import { runDaemon } from './daemon.js';
import { service } from './service.js';

export function parseArguments(args: string[]) {
  const positional: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--config' && args[i + 1]) configPath = args[++i];
    else if (arg.startsWith('-') && arg !== '--help' && arg !== '--version')
      throw new Error(`Unknown argument: ${arg}`);
    else positional.push(arg);
  }
  const [command = 'start', subcommand] = positional;
  if (positional.length > (command === 'service' ? 2 : 1)) throw new Error('Too many arguments');
  return { command, subcommand, location: paths(configPath) };
}

export async function startBackground(location: CovroPaths) {
  try {
    return await control(location, 'status');
  } catch (error) {
    if (!isNotRunning(error)) throw error;
  }
  await ensureConfig(location);
  await mkdir(location.state, { recursive: true, mode: 0o700 });
  const log = await open(location.log, 'a', 0o600);
  const child = spawn(
    process.execPath,
    [join(packageRoot, 'bin/covro.mjs'), 'run', '--config', location.config],
    {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      windowsHide: true,
    },
  );
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  child.unref();
  await log.close();
  for (let i = 0; i < 240; i++) {
    if (failure) throw failure;
    try {
      return await control(location, 'status');
    } catch (error) {
      if (!isNotRunning(error)) throw error;
    }
    if (child.exitCode !== null) throw new Error(`Covro 启动失败，请查看 ${location.log}`);
    await setTimeout(250);
  }
  throw new Error(`Covro 尚未确认启动，请运行 covro status 并查看 ${location.log}`);
}

export async function main(args = process.argv.slice(2)) {
  const { command, subcommand, location } = parseArguments(args);
  if (command === '--version') {
    console.log(packageInfo.version);
    return;
  }
  if (command === '--help' || command === 'help') {
    console.log(
      'Covro\n\ncovro [start|run|stop|status|logs] [--config FILE]\ncovro service install|uninstall [--config FILE]\n\n默认后台运行；service install 单独启用登录自启。',
    );
    return;
  }
  if (command === 'start') console.log(JSON.stringify(await startBackground(location), null, 2));
  else if (command === 'run') {
    await ensureConfig(location);
    await runDaemon(location.config);
  } else if (command === 'status' || command === 'stop') {
    try {
      console.log(JSON.stringify(await control(location, command), null, 2));
    } catch (error) {
      if (!isNotRunning(error)) throw error;
      console.log('Covro 未运行');
    }
  } else if (command === 'logs') {
    const handle = await open(location.log, 'r');
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
      await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      console.log(buffer.toString('utf8'));
    } finally {
      await handle.close();
    }
  } else if (command === 'service' && ['install', 'uninstall'].includes(subcommand ?? '')) {
    await service(location, subcommand === 'install');
    console.log(subcommand === 'install' ? '已启用 Covro 登录自启' : '已取消 Covro 登录自启');
  } else throw new Error('未知命令，运行 covro --help 查看用法');
}
