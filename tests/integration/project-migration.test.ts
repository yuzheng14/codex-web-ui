import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db/index.js';
import { defaultMigrationsFolder, migrateDatabase } from '../../src/server/db/migrate.js';
import { OperationStore } from '../../src/server/db/operations.js';
import { ProjectRegistry } from '../../src/server/projects.js';

it('backfills project ordering in the previous database using creation order and ID ties', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-project-order-upgrade-'));
  const db = openDatabase(join(root, 'data', 'app.sqlite'));
  try {
    const previous = join(root, 'previous');
    mkdirSync(join(previous, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(join(defaultMigrationsFolder, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const entries = journal.entries.slice(0, 6);
    expect(entries.at(-1)?.tag).toBe('0005_session_workspaces');
    for (const entry of entries)
      cpSync(join(defaultMigrationsFolder, `${entry.tag}.sql`), join(previous, `${entry.tag}.sql`));
    writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    migrateDatabase(db.database, previous);
    db.database
      .run(`INSERT INTO project_registrations (id, name, path, removed_at, created_at, updated_at) VALUES
      ('z', 'Z', '/missing/z', NULL, 1, 1),
      ('b', 'B', '/missing/b', NULL, 2, 2),
      ('a', 'A', '/missing/a', NULL, 2, 2),
      ('removed', 'Removed', '/missing/removed', 3, 0, 3)`);
    migrateDatabase(db.database);
    migrateDatabase(db.database);
    const registry = new ProjectRegistry([], db.database);
    expect(registry.list().map((p) => p.id)).toEqual(['z', 'a', 'b']);
    registry.reorder({ projectIds: ['b', 'z', 'a'] });
    expect(new ProjectRegistry([], db.database).list().map((p) => p.id)).toEqual(['b', 'z', 'a']);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('upgrades the parallel-thread database without losing executions, links or project identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-project-upgrade-'));
  const db = openDatabase(join(root, 'data', 'app.sqlite'));
  try {
    const previous = join(root, 'previous');
    mkdirSync(join(previous, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(join(defaultMigrationsFolder, 'meta/_journal.json'), 'utf8'),
    ) as {
      entries: { tag: string }[];
    };
    const entries = journal.entries.slice(0, 3);
    expect(entries.at(-1)?.tag).toBe('0002_allow_parallel_threads');
    for (const entry of entries)
      cpSync(join(defaultMigrationsFolder, `${entry.tag}.sql`), join(previous, `${entry.tag}.sql`));
    writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    migrateDatabase(db.database, previous);
    const project = join(root, 'project');
    mkdirSync(project);
    for (const id of ['first', 'second']) {
      db.database.run(
        `INSERT INTO operations (client_operation_id, kind, target, request_digest, state, created_at, updated_at) VALUES ('${id}', 'turn.start', '${id}', 'digest', 'acknowledged', 1, 1)`,
      );
      db.database.run(
        `INSERT INTO execution_markers (operation_id, thread_id, turn_id, workspace_key, codex_epoch, state, created_at) VALUES ('${id}', '${id}', 'turn-${id}', 'same-checkout', 'epoch', 'active', 1)`,
      );
    }
    db.database.run(
      "INSERT INTO thread_links (thread_id, project_id, cwd, source, updated_at) VALUES ('first', 'configured', '/old/project', 'appServer', 1)",
    );
    migrateDatabase(db.database);
    migrateDatabase(db.database);
    const store = new OperationStore(db.database);
    expect(store.activeMarkers()).toHaveLength(2);
    expect(store.get('first')).toMatchObject({
      state: 'acknowledged',
      projectId: null,
      requestDigest: 'digest',
    });
    expect(store.getThreadLink('first')).toMatchObject({
      projectId: 'configured',
      cwd: '/old/project',
    });
    const registry = new ProjectRegistry(
      [{ id: 'configured', name: 'Existing project', path: project }],
      db.database,
    );
    expect(registry.get('configured').name).toBe('Existing project');
    registry.rename('configured', { name: 'Renamed project' });
    const reloaded = new ProjectRegistry(
      [{ id: 'configured', name: 'Existing project', path: project }],
      db.database,
    );
    expect(reloaded.get('configured').name).toBe('Renamed project');
    expect(store.activeMarkers()).toHaveLength(2);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
