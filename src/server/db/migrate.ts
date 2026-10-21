import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { AppDatabase } from './index.js';
import { migrateSqlite, readMigrations } from './history.js';

/** Source and unbundled dist/server/db resolve to repository/dist drizzle respectively. */
export const defaultMigrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));
export const runtimeMigrationsFolder = existsSync(
  fileURLToPath(new URL('../../drizzle', import.meta.url)),
)
  ? fileURLToPath(new URL('../../drizzle', import.meta.url))
  : defaultMigrationsFolder;

export function migrateDatabase(
  database: AppDatabase,
  migrationsFolder = defaultMigrationsFolder,
): void {
  migrateSqlite(database.$client, readMigrations(migrationsFolder));
}
