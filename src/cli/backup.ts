import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { BackupStatus } from '../shared/backups.js';
import { AppError } from '../shared/errors.js';
import { createBackupStore } from '../backups/factory.js';
import { acquireMaintenanceLock } from '../backups/lock.js';
import {
  assertNoPendingRestore,
  previewRestore,
  repairRestore,
  restoreBackup,
} from '../backups/restore.js';
import { acquireInstanceLock } from '../server/instance-lock.js';
import { loadConfig } from '../server/config.js';
import { backupFailure } from '../backups/store.js';
import { control, isNotRunning } from './control.js';
import type { CovroPaths } from './paths.js';

export async function backupCommand(
  location: CovroPaths,
  subcommand = 'list',
  id?: string,
  confirm?: string,
  recoveryDataDir?: string,
) {
  const dataDir = recoveryDataDir
    ? resolve(recoveryDataDir)
    : (await loadConfig({ configPath: location.config, development: false })).dataDir;
  const store = createBackupStore(location.config, dataDir);
  try {
    if (subcommand === 'list')
      return { directory: store.options.directory, records: await store.list() };
    if (subcommand === 'verify' && id) return await store.verify(id);
    if (subcommand === 'restore' && id) {
      if (!confirm) return await previewRestore(store, id);
      try {
        await control(location, 'status');
        throw new AppError('RESTORE_RUNNING', '请先运行 covro stop，停止当前实例后再恢复。', 409);
      } catch (error) {
        if (!isNotRunning(error)) throw error;
      }
      return await restoreBackup(store, id, confirm);
    }
    if (subcommand === 'repair') return await repairRestore(store);
    if (subcommand !== 'create' || id)
      throw new AppError(
        'BACKUP_ARGUMENT',
        '用法：covro backup create|list|verify ID|restore ID|repair',
        400,
      );
    const operation = randomUUID();
    let running = false;
    try {
      await control(location, 'status');
      running = true;
    } catch (error) {
      if (!isNotRunning(error)) throw error;
    }
    if (running) {
      if (recoveryDataDir)
        throw new AppError('BACKUP_ARGUMENT', '--data-dir 仅用于停服后的恢复或备份。');
      let status = await control<BackupStatus>(location, 'backup-create', {
        clientOperationId: operation,
      });
      for (;;) {
        const record = status.records.find((entry) => entry.id === operation);
        if (record && !['waiting', 'copying', 'verifying'].includes(record.phase)) {
          if (record.phase !== 'succeeded')
            throw new AppError('BACKUP_FAILED', record.message, 500);
          return record;
        }
        await setTimeout(500);
        status = await control<BackupStatus>(location, 'backup-status');
      }
    }
    const release = await acquireInstanceLock(dataDir);
    let releaseMaintenance: (() => Promise<void>) | undefined;
    try {
      releaseMaintenance = await acquireMaintenanceLock(dataDir);
      await assertNoPendingRestore(store.options.directory);
      return await store.create({ id: operation, trigger: 'manual' });
    } finally {
      await releaseMaintenance?.();
      await release();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('BACKUP_FAILED', backupFailure(error), 500);
  }
}
