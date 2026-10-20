import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { DatabaseCompatibility } from '../../shared/database.js';

export interface Migration {
  hash: string;
  createdAt: number;
  sql: string[];
}

export function readMigrations(folder: string): Migration[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  let last = 0;
  return journal.entries.map((entry, index) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.tag) || entry.idx !== index || entry.when <= last)
      throw new Error('Invalid database migration journal');
    last = entry.when;
    const source = readFileSync(join(folder, `${entry.tag}.sql`), 'utf8');
    return {
      hash: createHash('sha256').update(source).digest('hex'),
      createdAt: entry.when,
      sql: source.split('--> statement-breakpoint'),
    };
  });
}

/** A public ordinal never replaces validation of the immutable migration chain. */
export function inspectDatabase(sqlite: Database.Database, migrations: Migration[]) {
  const recorded = sqlite.pragma('user_version', { simple: true }) as number;
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const applied = tables.some((table) => table.name === '__drizzle_migrations')
    ? (sqlite
        .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
        .all() as { hash: string; created_at: number }[])
    : [];
  if (
    (!applied.length && tables.some((table) => table.name !== '__drizzle_migrations')) ||
    applied.some(
      (entry, index) =>
        entry.hash !== migrations[index]?.hash || entry.created_at !== migrations[index]?.createdAt,
    ) ||
    (recorded !== 0 && recorded !== applied.length)
  )
    throw new Error(
      '数据库 Schema 或迁移历史不兼容；请使用兼容版本或恢复升级前备份，不会改写或重建数据库。',
    );
  return {
    schemaVersion: applied.length,
    legacy: recorded === 0,
    migrationHashes: applied.map((entry) => entry.hash),
  };
}

export function requireRestorable(version: number, contract: DatabaseCompatibility) {
  if (version < contract.minRestorableSchemaVersion || version > contract.schemaVersion)
    throw new Error(
      `备份 Schema ${version} 不兼容目标版本（支持 ${contract.minRestorableSchemaVersion}–${contract.schemaVersion}）。`,
    );
}

/** SQL, Drizzle's existing journal and the public version commit together. */
export function migrateSqlite(sqlite: Database.Database, migrations: Migration[]) {
  const before = inspectDatabase(sqlite, migrations);
  sqlite.transaction(() => {
    sqlite.exec(
      'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    for (const migration of migrations.slice(before.schemaVersion)) {
      for (const statement of migration.sql) sqlite.exec(statement);
      sqlite
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run(migration.hash, migration.createdAt);
    }
    sqlite.pragma(`user_version = ${migrations.length}`);
  })();
}
