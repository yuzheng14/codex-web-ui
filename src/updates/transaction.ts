import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { UpdateRun } from '../shared/updates.js';
import { copyDurable, saveJson } from './files.js';

export interface TransactionPaths {
  root: string;
  prefix: string;
  candidate: string;
  previous: string;
  backup: string;
  dataDir: string;
  config: string;
}
export interface UpdateEffects {
  waitForIdle(): Promise<void>;
  stop(): Promise<void>;
  start(candidate: boolean): Promise<void>;
  verify(): Promise<void>;
  commit(): Promise<void>;
  hasCommitted?(): Promise<boolean>;
  resume?(): Promise<void>;
  phase(phase: UpdateRun['phase'], message: string): Promise<void>;
}
const exists = async (path: string) =>
  stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

/** Rollback is confined to admission: no new business writes are accepted before commit. */
export async function activateUpdate(paths: TransactionPaths, effects: UpdateEffects) {
  let stopped = false;
  let moved = false;
  let backedUp = false;
  let committed = false;
  try {
    await effects.phase('waiting', '候选包已准备好，等待所有任务、审批与待核对操作结束');
    await effects.waitForIdle();
    await effects.phase('stopping', '已关闭新任务入口，正在停止旧服务并备份数据');
    // stop may fail after the process has already exited; recovery must restart the old service.
    stopped = true;
    await effects.stop();
    await mkdir(paths.backup, { recursive: true, mode: 0o700 });
    for (const name of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm']) {
      if (await exists(join(paths.dataDir, name)))
        await copyDurable(join(paths.dataDir, name), join(paths.backup, name));
    }
    await copyDurable(paths.config, join(paths.backup, 'config.json'));
    await saveJson(join(paths.backup, 'snapshot.json'), { complete: true });
    backedUp = true;
    await rename(paths.root, paths.previous);
    moved = true;
    await rename(paths.candidate, paths.root);
    await effects.phase('verifying', '正在启动新版、迁移数据库并验证；业务写入保持暂停');
    await effects.start(true);
    await effects.verify();
    await effects.commit();
    committed = true;
    // The new gateway persists the commit before admitting requests. Never restore its data later.
    return;
  } catch (error) {
    if (committed || (await effects.hasCommitted?.())) return;
    if (!stopped) {
      await effects.resume?.();
      await effects.phase('failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
    try {
      await effects.stop();
      if (moved) {
        await rm(paths.root, { recursive: true, force: true });
        await rename(paths.previous, paths.root);
      }
      if (backedUp) {
        for (const name of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm']) {
          await rm(join(paths.dataDir, name), { force: true });
          if (await exists(join(paths.backup, name)))
            await copyDurable(join(paths.backup, name), join(paths.dataDir, name));
        }
        await copyDurable(join(paths.backup, 'config.json'), paths.config);
      }
      await effects.phase(
        'rolledBack',
        `新版启动失败，已恢复旧版：${error instanceof Error ? error.message : String(error)}`,
      );
      await effects.start(false);
    } catch (recovery) {
      await effects.phase(
        'failed',
        `升级失败且恢复尚未完成；保留备份 ${paths.backup}。${String(error)}；恢复：${String(recovery)}`,
      );
      throw recovery;
    }
    throw error;
  }
}

export function transactionPaths(
  root: string,
  id: string,
  dataDir: string,
  config: string,
  backup: string,
): TransactionPaths {
  const prefix = join(dirname(root), `.covro-stage-${id}`);
  return {
    root,
    prefix,
    candidate: join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      'covro',
    ),
    previous: join(dirname(root), `.covro-previous-${id}`),
    backup,
    dataDir,
    config,
  };
}
