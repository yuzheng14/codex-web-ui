import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import type { AppDatabase } from './index.js';

/** Source and unbundled dist/server/db resolve to repository/dist drizzle respectively. */
export const defaultMigrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));

export function migrateDatabase(
  database: AppDatabase,
  migrationsFolder = defaultMigrationsFolder,
): void {
  const table = database.get(
    sql`SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'`,
  );
  if (table) {
    const applied = database.all<{ hash: string }>(
      sql`SELECT hash FROM __drizzle_migrations ORDER BY created_at`,
    );
    const migrations = readMigrationFiles({ migrationsFolder });
    if (applied.some((entry, i) => entry.hash !== migrations[i]?.hash))
      throw new Error(
        '当前安装不兼容数据库迁移历史；请使用兼容版本或升级前备份，不会改写或重建数据库。',
      );
  }
  migrate(database, { migrationsFolder });
}
