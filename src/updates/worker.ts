import { npmPackageName } from '../shared/package.js';
import {
  codexCompatibilitySchema,
  requireCodexCompatibility,
} from '../shared/codex-compatibility.js';
// Bundled with its pure JavaScript dependencies and copied outside the installation before launch.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { access, readFile, mkdir, readdir, rm, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import type Database from 'better-sqlite3';
import type { UpdateRun } from '../shared/updates.js';
import type { UpdateContext } from './manager.js';
import { control, isNotRunning } from '../cli/control.js';
import { startBackground, stopBackground } from '../cli/background.js';
import { copyDurable, readJson, saveJson } from './files.js';
import { activateUpdate, transactionPaths } from './transaction.js';
import { inspectInstallation, registry } from './registry.js';

const exec = promisify(execFile);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
type DaemonStatus = {
  version: string;
  pid: number;
  maintenance?: boolean;
  codexVersion?: string | null;
  codexReady?: boolean;
};

async function startService(context: UpdateContext) {
  // Shared with `covro start`: never inherit a Background security session on macOS.
  // Activation is checked from the durable update record by the daemon.
  await startBackground(context.location, join(context.root, 'bin/covro.mjs'));
}
async function stopService(context: UpdateContext) {
  await stopBackground(context.location);
}

async function verifyRestoredService(context: UpdateContext, version: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const restored = await control<DaemonStatus>(context.location, 'status');
      if (restored.version !== version || restored.maintenance)
        throw new Error('旧版恢复身份不匹配');
      return;
    } catch (error) {
      if (attempt === 239) throw error;
    }
    await setTimeout(250);
  }
}

async function verifyMigrations(context: UpdateContext, candidate: string) {
  // Loading the existing native addon happens before any package path is replaced.
  const require = createRequire(join(context.root, 'package.json'));
  const Sqlite = require('better-sqlite3') as typeof Database;
  const filename = join(context.dataDir, 'app.sqlite');
  try {
    await access(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const db = new Sqlite(filename, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'")
      .get();
    if (!table) return;
    const applied = db
      .prepare('SELECT hash FROM __drizzle_migrations ORDER BY created_at')
      .all() as { hash: string }[];
    const journal = JSON.parse(
      await readFile(join(candidate, 'dist/drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const hashes = await Promise.all(
      journal.entries.map(async (entry) => {
        if (!/^[a-zA-Z0-9_-]+$/.test(entry.tag)) throw new Error('候选包包含无效迁移路径');
        return createHash('sha256')
          .update(await readFile(join(candidate, 'dist/drizzle', `${entry.tag}.sql`)))
          .digest('hex');
      }),
    );
    if (applied.some((entry, i) => entry.hash !== hashes[i]))
      throw new Error('目标版本不兼容当前数据库迁移历史。请等待兼容版本，或使用独立测试数据目录。');
  } finally {
    db.close();
  }
}

async function worker(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    stale: 10_000,
    update: 2_000,
    retries: { retries: 30, minTimeout: 100, maxTimeout: 500 },
  });
  let record = await readJson<UpdateRun>(join(directory, 'run.json'));
  const context = await readJson<UpdateContext>(join(directory, 'context.json'));
  if (!record || !context) {
    await release();
    throw new Error('缺少升级记录');
  }
  const update = async (phase: UpdateRun['phase'], detail: string) => {
    record = { ...record!, phase, message: detail, updatedAt: Date.now() };
    await saveJson(join(directory, 'run.json'), record);
  };
  const paths = transactionPaths(
    context.root,
    record.id,
    context.dataDir,
    context.location.config,
    join(directory, `backup-${record.id}`),
  );
  try {
    if (process.argv[3] === '--repair') {
      const active = await control<DaemonStatus>(context.location, 'status').catch(
        (error: unknown) => {
          if (isNotRunning(error)) return undefined;
          throw error;
        },
      );
      if (record.committed) return;
      if (active && !active.maintenance && active.version !== record.from)
        throw new Error('当前服务可能已接受新版业务数据；拒绝恢复旧快照，请使用兼容版本检查。');
      const previous = await readJson<{ version: string; name: string }>(
        join(paths.previous, 'package.json'),
      );
      if (previous) {
        if (active && !active.maintenance)
          throw new Error('旧服务已恢复业务写入；拒绝用升级前快照覆盖现有数据，请保留现场检查。');
        if (previous.name !== npmPackageName || previous.version !== record.from)
          throw new Error('旧版备份身份不匹配');
        const snapshot = await readJson<{ complete: boolean }>(join(paths.backup, 'snapshot.json'));
        if (!snapshot?.complete) throw new Error('数据库备份不完整，保留全部现场供检查');
      } else {
        const original = await readJson<{ name: string; version: string }>(
          join(paths.root, 'package.json'),
        );
        if (original?.name !== npmPackageName || original.version !== record.from)
          throw new Error('未找到完整的上一版本安装');
      }
      if (active && !active.maintenance) {
        const admission = await control<{ ready: boolean }>(context.location, 'prepare-update');
        if (!admission.ready) throw new Error('仍有任务、审批或待核对操作，不能恢复旧安装');
      }
      await stopService(context);
      if (previous) {
        await rm(paths.root, { recursive: true, force: true });
        await rename(paths.previous, paths.root);
        for (const name of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm']) {
          await rm(join(paths.dataDir, name), { force: true });
          try {
            await copyDurable(join(paths.backup, name), join(paths.dataDir, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        await copyDurable(join(paths.backup, 'config.json'), paths.config);
      }
      const restored = await readJson<{ name: string; version: string }>(
        join(paths.root, 'package.json'),
      );
      if (restored?.name !== npmPackageName || restored.version !== record.from)
        throw new Error('未找到完整的上一版本安装');
      await update('rolledBack', '已恢复上次未完成的升级，正在启动上一版本');
      try {
        await startService(context);
        await verifyRestoredService(context, record.from);
        await update('rolledBack', '已恢复上次未完成的升级，上一版本已就绪');
      } catch (error) {
        await update('failed', `旧版恢复启动失败，保留备份：${message(error)}`);
        throw error;
      }
      return;
    }
    const reason = await inspectInstallation(context.root);
    if (reason) throw new Error(reason);
    // A second managed configuration must be stopped before replacing their shared npm package.
    for (const key of await readdir(join(context.location.home, 'instances'))) {
      if (key === context.location.key) continue;
      const instance = await readJson<{ root: string; config: string; socket: string }>(
        join(context.location.home, 'instances', key, 'instance.json'),
      );
      if (instance?.root !== context.root) continue;
      try {
        await control({ ...context.location, socket: instance.socket }, 'status');
        throw new Error('同一 npm 安装还有其他 Covro 实例，请先停止其他实例再升级。');
      } catch (error) {
        if (!isNotRunning(error)) throw error;
      }
    }
    await access(dirname(context.root), constants.W_OK);
    // npm global layout keeps production dependencies nested in the package being swapped.
    await exec(
      'npm',
      [
        'install',
        '--global',
        '--prefix',
        paths.prefix,
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        `--registry=${registry}`,
        '--allow-scripts=better-sqlite3',
        `${npmPackageName}@${record.target}`,
      ],
      { timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const candidate = await readJson<{ name: string; version: string; covroCodex?: unknown }>(
      join(paths.candidate, 'package.json'),
    );
    if (candidate?.name !== npmPackageName || candidate.version !== record.target)
      throw new Error('候选包身份或版本不匹配');
    if (!record.codex) throw new Error('缺少 Codex 升级校验记录，请重新检查更新');
    const manifest = codexCompatibilitySchema.parse(candidate.covroCodex);
    if (JSON.stringify(manifest) !== JSON.stringify(record.codex.manifest))
      throw new Error('候选包的 Codex 兼容声明与检查时不一致，拒绝切换');
    const checkCodex = async (current?: DaemonStatus) => {
      const state = current ?? (await control<DaemonStatus>(context.location, 'status'));
      if (state.codexVersion !== record!.codex!.version)
        throw new Error('Codex 版本在等待升级期间发生变化，请重新检查更新');
      requireCodexCompatibility(
        manifest,
        state.codexVersion ?? null,
        record!.codex!.confirmedUnverified,
      );
    };
    await checkCodex();
    await exec(process.execPath, [join(paths.candidate, 'bin/covro.mjs'), '--version'], {
      timeout: 30_000,
    });
    const nativeProbe =
      'const {createRequire}=await import("node:module"); const r=createRequire(process.argv[1]); const DB=r("better-sqlite3"); const db=new DB(":memory:"); db.close();';
    await exec(
      process.execPath,
      ['--input-type=module', '-e', nativeProbe, join(paths.candidate, 'package.json')],
      { timeout: 30_000 },
    );
    await verifyMigrations(context, paths.candidate);
    await activateUpdate(paths, {
      phase: update,
      waitForIdle: async () => {
        // Queue without blocking normal work; admission closes atomically only after all blockers clear.
        for (;;) {
          await checkCodex();
          const result = await control<{ ready: boolean; reason?: string }>(
            context.location,
            'prepare-update',
          );
          if (result.ready) {
            await checkCodex();
            return;
          }
          await update('waiting', result.reason ?? '等待所有任务结束');
          await setTimeout(2_000);
        }
      },
      stop: () => stopService(context),
      start: async (candidate) => {
        await startService(context);
        if (!candidate) await verifyRestoredService(context, record!.from);
      },
      verify: async () => {
        for (let attempt = 0; attempt < 240; attempt++) {
          const current = await control<DaemonStatus>(context.location, 'status').catch(
            () => undefined,
          );
          if (current) {
            if (current.version !== record!.target || !current.maintenance)
              throw new Error('新版服务身份或维护状态不匹配');
            await checkCodex(current);
            if (current.codexReady) return;
          }
          await setTimeout(250);
        }
        throw new Error('新版服务或 Codex 连接未就绪，拒绝激活');
      },
      commit: async () => {
        // Gateway commits the durable result before reopening task admission.
        await control(context.location, 'activate-update', {
          id: record!.id,
          channel: record!.channel,
        });
        const final = await readJson<UpdateRun>(join(directory, 'run.json'));
        if (!final?.committed) throw new Error('新版尚未确认升级提交');
        record = final;
      },
      hasCommitted: async () =>
        Boolean((await readJson<UpdateRun>(join(directory, 'run.json')))?.committed),
      resume: async () => {
        await control(context.location, 'cancel-update').catch(() => {});
      },
    });
  } catch (error) {
    const latest = await readJson<UpdateRun>(join(directory, 'run.json'));
    if (latest?.committed) {
      // A lost commit response cannot authorize restoring older data.
      record = latest;
    } else if (!['rolledBack', 'failed'].includes(record.phase))
      await update('failed', message(error));
    console.error(message(error));
    process.exitCode = record.committed || record.phase === 'rolledBack' ? 0 : 1;
  } finally {
    await release();
    // Keep the last good installation and database backup for explicit recovery.
    if (record.phase === 'succeeded' || record.phase === 'rolledBack') {
      await rm(paths.prefix, { recursive: true, force: true });
    }
  }
}

if (process.argv[2])
  void worker(process.argv[2]).catch((error: unknown) => {
    console.error(message(error));
    process.exitCode = 1;
  });
