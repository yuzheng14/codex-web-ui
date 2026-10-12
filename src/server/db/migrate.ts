import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { AppDatabase } from './index.js';

/** Source and unbundled dist/server/db resolve to repository/dist drizzle respectively. */
export const defaultMigrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));

export function migrateDatabase(
  database: AppDatabase,
  migrationsFolder = defaultMigrationsFolder,
): void {
  migrate(database, { migrationsFolder });
}
