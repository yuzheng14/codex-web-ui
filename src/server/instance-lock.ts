import { chmod, mkdir } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { AppError } from '../shared/errors.js';
/** Atomic mkdir + heartbeat handles stale locks without signalling saved PIDs. */
export async function acquireInstanceLock(dataDir: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  try {
    return await lockfile.lock(dataDir, {
      realpath: true,
      stale: 10_000,
      update: 2_000,
      retries: 0,
    });
  } catch {
    throw new AppError(
      'INSTANCE_LOCKED',
      'Another gateway or migration owns this dataDir; retry after a stale lock expires',
      409,
    );
  }
}
