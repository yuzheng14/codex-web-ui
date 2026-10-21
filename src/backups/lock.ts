import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { AppError } from '../shared/errors.js';

/** Shared by live manual snapshots, update workers and offline restoration. */
export async function acquireMaintenanceLock(dataDir: string) {
  try {
    const directory = join(dataDir, '.covro-maintenance');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await lockfile.lock(directory, {
      realpath: true,
      stale: 10_000,
      update: 2_000,
      retries: 0,
    });
  } catch {
    throw new AppError('MAINTENANCE_BUSY', '已有备份、升级或恢复正在处理，请完成后重试。', 409);
  }
}
