import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { AppError } from '../shared/errors.js';
import { acquireInstanceLock } from '../server/instance-lock.js';
import { parseConfig } from '../server/config.js';
import { migrateSqlite } from '../server/db/history.js';
import { copyDurable, readJson, saveJson, syncDirectory } from '../updates/files.js';
import { acquireMaintenanceLock } from './lock.js';
import { type BackupStore } from './store.js';

const fileNames = ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm', 'config.json'] as const;
const journalSchema = z
  .object({
    id: z.string().uuid(),
    backupId: z.string(),
    phase: z.enum(['prepared', 'replacing', 'committed', 'rolledBack']),
    originals: z
      .array(
        z.object({ name: z.enum(fileNames), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
      )
      .max(4),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
const journalPath = (store: BackupStore) => join(store.options.directory, 'restore.json');
const stagePath = (store: BackupStore, id: string) =>
  join(store.options.dataDir, `.covro-restore-${id}`);
const configStage = (store: BackupStore, id: string) =>
  join(dirname(store.options.config), `.covro-restore-${id}.tmp`);
async function hash(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Recovery file is not a regular file');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
export async function assertNoPendingRestore(directory: string) {
  const value = await readJson(join(directory, 'restore.json'));
  if (value === undefined) return;
  const journal = journalSchema.parse(value);
  if (['prepared', 'replacing'].includes(journal.phase))
    throw new AppError(
      'RESTORE_PENDING',
      '上次恢复尚未完成，拒绝开放写入；请运行 covro backup repair。',
      503,
    );
}
async function restoreOriginals(store: BackupStore, journal: Journal) {
  const directory = stagePath(store, journal.id);
  for (const file of journal.originals)
    if ((await hash(join(directory, 'original', file.name))) !== file.sha256)
      throw new Error('Recovery copy checksum mismatch');
  for (const name of fileNames) {
    const target =
      name === 'config.json' ? store.options.config : join(store.options.dataDir, name);
    const original = journal.originals.find((file) => file.name === name);
    if (original) {
      await copyDurable(join(directory, 'original', name), target);
      await chmod(target, 0o600);
    } else await rm(target, { force: true });
  }
  await rm(configStage(store, journal.id), { force: true });
  await saveJson(journalPath(store), { ...journal, phase: 'rolledBack' });
}
export async function previewRestore(store: BackupStore, id: string) {
  const manifest = await store.verify(id);
  if (
    resolve(manifest.configPath) !== resolve(store.options.config) ||
    resolve(manifest.dataDir) !== resolve(store.options.dataDir)
  )
    throw new AppError(
      'RESTORE_INSTANCE_MISMATCH',
      '此备份属于其他配置或数据目录，不能覆盖当前实例。',
      409,
    );
  const config = parseConfig(
    JSON.parse(await readFile(join(store.path(id), 'config.json'), 'utf8')),
    store.options.config,
  );
  if (config.dataDir !== resolve(store.options.dataDir))
    throw new AppError('RESTORE_CONFIG_MISMATCH', '备份配置会切换数据目录，拒绝恢复。', 409);
  return {
    backupId: id,
    appVersion: manifest.appVersion,
    backupSchema: manifest.schemaVersion,
    targetSchema: store.options.contract.schemaVersion,
    overwrite: [store.options.config, join(store.options.dataDir, 'app.sqlite')],
    warning:
      '将覆盖服务配置及 Covro 应用数据，丢弃备份之后的应用数据；Codex 历史与项目文件不参与恢复。',
    confirmation: `covro backup restore ${id} --confirm ${id} --config ${JSON.stringify(store.options.config)}`,
  };
}
/** Offline only: gateway startup, explicit migrations and restore all share the instance lock. */
export async function restoreBackup(store: BackupStore, id: string, confirm?: string) {
  const preview = await previewRestore(store, id);
  if (confirm === undefined) return { ...preview, restored: false as const };
  if (confirm !== id)
    throw new AppError('RESTORE_CONFIRMATION', '确认值必须与待恢复的备份 ID 完全一致。', 400);
  const releaseInstance = await acquireInstanceLock(store.options.dataDir);
  let releaseMaintenance: (() => Promise<void>) | undefined;
  let journal: Journal | undefined;
  try {
    releaseMaintenance = await acquireMaintenanceLock(store.options.dataDir);
    await assertNoPendingRestore(store.options.directory);
    await previewRestore(store, id); // Revalidate after obtaining exclusive ownership.
    const operation = randomUUID();
    const directory = stagePath(store, operation);
    await mkdir(join(directory, 'original'), { recursive: true, mode: 0o700 });
    const originals: Journal['originals'] = [];
    for (const name of fileNames) {
      const source =
        name === 'config.json' ? store.options.config : join(store.options.dataDir, name);
      try {
        await hash(source);
        await copyDurable(source, join(directory, 'original', name));
        await chmod(join(directory, 'original', name), 0o600);
        originals.push({ name, sha256: await hash(join(directory, 'original', name)) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await copyDurable(join(store.path(id), 'app.sqlite'), join(directory, 'app.sqlite'));
    const staged = new store.options.Sqlite(join(directory, 'app.sqlite'));
    try {
      migrateSqlite(staged, store.options.migrations);
      staged.pragma('journal_mode = DELETE');
      if (
        staged.pragma('integrity_check', { simple: true }) !== 'ok' ||
        (staged.pragma('foreign_key_check') as unknown[]).length
      )
        throw new Error('Staged migration failed integrity check');
    } finally {
      staged.close();
    }
    await chmod(join(directory, 'app.sqlite'), 0o600);
    await copyDurable(join(store.path(id), 'config.json'), configStage(store, operation));
    await chmod(configStage(store, operation), 0o600);
    journal = { id: operation, backupId: id, phase: 'prepared', originals };
    await saveJson(journalPath(store), journal);
    journal.phase = 'replacing';
    await saveJson(journalPath(store), journal);
    for (const name of ['app.sqlite-wal', 'app.sqlite-shm'])
      await rm(join(store.options.dataDir, name), { force: true });
    await rename(join(directory, 'app.sqlite'), join(store.options.dataDir, 'app.sqlite'));
    await rename(configStage(store, operation), store.options.config);
    await syncDirectory(store.options.dataDir);
    await syncDirectory(dirname(store.options.config));
    await saveJson(journalPath(store), { ...journal, phase: 'committed' });
    return {
      ...preview,
      restored: true as const,
      recoveryCopy: directory,
      message: '恢复完成，服务保持停止；运行 covro start 启动。',
    };
  } catch (error) {
    if (journal) {
      try {
        await restoreOriginals(store, journal);
      } catch {
        throw new AppError(
          'RESTORE_PENDING',
          '恢复失败且原数据尚未恢复，已保留现场；请运行 covro backup repair。',
          500,
        );
      }
    }
    if (!journal && error instanceof AppError) throw error;
    throw new AppError(
      'RESTORE_FAILED',
      '恢复未完成，原数据已保留；请检查磁盘、权限及备份后重试。',
      500,
    );
  } finally {
    await releaseMaintenance?.();
    await releaseInstance();
  }
}
export async function repairRestore(store: BackupStore) {
  const releaseInstance = await acquireInstanceLock(store.options.dataDir);
  let releaseMaintenance: (() => Promise<void>) | undefined;
  try {
    releaseMaintenance = await acquireMaintenanceLock(store.options.dataDir);
    const journal = journalSchema.parse(await readJson(journalPath(store)));
    if (['committed', 'rolledBack'].includes(journal.phase))
      return { repaired: false, phase: journal.phase };
    await restoreOriginals(store, journal);
    return {
      repaired: true,
      phase: 'rolledBack',
      message: '已恢复恢复操作前的文件，服务保持停止。',
    };
  } finally {
    await releaseMaintenance?.();
    await releaseInstance();
  }
}
