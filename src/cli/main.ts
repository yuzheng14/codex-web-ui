import type { UpdateStatus } from '../shared/updates.js';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { control, isNotRunning } from './control.js';
import { startBackground as startManagedBackground, stopBackground } from './background.js';
import { randomUUID } from 'node:crypto';
import { ensureConfig, packageInfo, packageRoot, paths, type CovroPaths } from './paths.js';
import { runDaemon } from './daemon.js';
import { service } from './service.js';
import { UpdateManager } from '../updates/manager.js';
import { loadConfig } from '../server/config.js';

export function parseArguments(args: string[]) {
  const positional: string[] = [];
  let configPath: string | undefined;
  let channel: 'stable' | 'beta' | 'dev' | undefined;
  let allowDowngrade = false;
  let allowUnverifiedCodex = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--config' && args[i + 1]) configPath = args[++i];
    else if (arg === '--channel' && ['stable', 'beta', 'dev'].includes(args[i + 1] ?? ''))
      channel = args[++i] as typeof channel;
    else if (arg === '--allow-downgrade') allowDowngrade = true;
    else if (arg === '--allow-unverified-codex') allowUnverifiedCodex = true;
    else if (arg.startsWith('-') && arg !== '--help' && arg !== '--version')
      throw new Error(`Unknown argument: ${arg}`);
    else positional.push(arg);
  }
  const [command = 'start', subcommand] = positional;
  if (positional.length > (['service', 'update'].includes(command) ? 2 : 1))
    throw new Error('Too many arguments');
  if ((channel || allowDowngrade || allowUnverifiedCodex) && command !== 'update')
    throw new Error('升级选项仅用于 update');
  return {
    command,
    subcommand,
    channel,
    allowDowngrade,
    allowUnverifiedCodex,
    location: paths(configPath),
  };
}

export async function startBackground(location: CovroPaths) {
  try {
    return await control(location, 'status');
  } catch (error) {
    if (!isNotRunning(error)) throw error;
  }
  await ensureConfig(location);
  return startManagedBackground(location, join(packageRoot, 'bin/covro.mjs'));
}

export async function main(args = process.argv.slice(2)) {
  const { command, subcommand, channel, allowDowngrade, allowUnverifiedCodex, location } =
    parseArguments(args);
  if (command === '--version') {
    console.log(packageInfo.version);
    return;
  }
  if (command === '--help' || command === 'help') {
    console.log(
      'Covro\n\ncovro [start|run|stop|status|logs] [--config FILE]\ncovro update [status|repair] [--channel stable|beta|dev] [--allow-downgrade] [--allow-unverified-codex]\ncovro service install|uninstall [--config FILE]\n\n默认后台运行；service install 单独启用登录自启。',
    );
    return;
  }
  if (command === 'start') console.log(JSON.stringify(await startBackground(location), null, 2));
  else if (command === 'run') {
    await ensureConfig(location);
    await runDaemon(location.config);
  } else if (command === 'update') {
    if (subcommand === 'repair') {
      const config = await loadConfig({ configPath: location.config, development: false });
      const manager = new UpdateManager(location, config.dataDir);
      console.log(JSON.stringify(await manager.repair(), null, 2));
      return;
    }
    if (subcommand && subcommand !== 'status') throw new Error('未知升级命令');
    await startBackground(location);
    let codexConfirmation;
    if (allowUnverifiedCodex && !subcommand) {
      const checked = await control<UpdateStatus>(location, 'update-check', { channel });
      const candidate = checked.available;
      if (candidate?.codex.status === 'unverified' && candidate.codex.version)
        codexConfirmation = { version: candidate.codex.version, target: candidate.version };
    }
    console.log(
      JSON.stringify(
        await control(
          location,
          subcommand === 'status' ? 'update-check' : 'update',
          subcommand === 'status'
            ? { channel }
            : { clientOperationId: randomUUID(), channel, allowDowngrade, codexConfirmation },
        ),
        null,
        2,
      ),
    );
  } else if (command === 'status' || command === 'stop') {
    try {
      if (command === 'stop') {
        await stopBackground(location);
        console.log('Covro 已停止');
      } else console.log(JSON.stringify(await control(location, command), null, 2));
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
