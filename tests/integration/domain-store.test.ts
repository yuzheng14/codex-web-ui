import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID as operationId } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/server/db/index.js';
import { defaultMigrationsFolder, migrateDatabase } from '../../src/server/db/migrate.js';
import { OperationStore, requestDigest } from '../../src/server/db/operations.js';
import { operations } from '../../src/server/db/schema.js';
import { databaseHarness as harness } from './domain-db-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
const setup = () => {
  const value = harness();
  resources.push(value);
  return value;
};
afterEach(() => {
  for (const value of resources.splice(0)) value.close();
});

describe('durable operation identity and dispatch transactions', () => {
  it('uses SQLite uniqueness without changing the original receipt and normalizes object order', () => {
    const { store } = setup();
    const id = operationId();
    expect(store.accept(id, 'turn.start', 'thread', { z: 1, a: { x: 2 } }).inserted).toBe(true);
    store.dispatch(id);
    store.acknowledge(id, { turnId: 'turn' });
    const original = store.get(id);
    expect(store.accept(id, 'turn.start', 'thread', { a: { x: 2 }, z: 1 }).inserted).toBe(false);
    expect(() => store.accept(id, 'turn.start', 'thread', { z: 2 })).toThrow('不同的请求');
    expect(store.get(id)).toEqual(original);
    expect(requestDigest({ a: undefined, b: 'x' })).toBe(requestDigest({ b: 'x' }));
  });

  it('rolls back the dispatch state when execution reservation fails', () => {
    const { store } = setup();
    const first = operationId();
    const second = operationId();
    store.accept(first, 'turn.start', 'one', {});
    store.dispatch(first, { threadId: 'one', workspaceKey: 'checkout', codexEpoch: 'epoch' });
    store.accept(second, 'turn.start', 'two', {});
    expect(() =>
      store.dispatch(second, { threadId: 'two', workspaceKey: 'checkout', codexEpoch: 'epoch' }),
    ).toThrow('工作区');
    expect(store.get(second)?.state).toBe('accepted');
    expect(store.marker(second)).toBeUndefined();
    expect(store.activeMarkers()).toHaveLength(1);
    expect(() =>
      store.dispatch('missing', { threadId: 'three', workspaceKey: 'other', codexEpoch: 'epoch' }),
    ).toThrow();
    expect(store.activeMarkers()).toHaveLength(1);
    // Force a NOT NULL failure after the state UPDATE, proving the transaction rolls it back.
    expect(() =>
      store.dispatch(second, { threadId: 'two', workspaceKey: 'other', codexEpoch: null as never }),
    ).toThrow();
    expect(store.get(second)?.state).toBe('accepted');
    expect(store.marker(second)).toBeUndefined();
  });

  it('recovers ambiguous dispatch and acknowledged unfinished turns after reopening, without replay', () => {
    const ctx = setup();
    const uncertain = operationId();
    const acknowledged = operationId();
    const accepted = operationId();
    for (const id of [uncertain, acknowledged, accepted])
      ctx.store.accept(id, 'turn.start', id, {});
    ctx.store.dispatch(uncertain, { threadId: 'a', workspaceKey: 'a', codexEpoch: 'old' });
    ctx.store.dispatch(acknowledged, { threadId: 'b', workspaceKey: 'b', codexEpoch: 'old' });
    ctx.store.acknowledge(acknowledged, { turnId: 'turn' }, 'turn');
    const reopened = openDatabase(ctx.filename);
    try {
      migrateDatabase(reopened.database);
      const recovered = new OperationStore(reopened.database);
      recovered.recover();
      expect(recovered.get(uncertain)?.state).toBe('unknown');
      expect(recovered.get(acknowledged)).toMatchObject({
        state: 'acknowledged',
        result: { turnId: 'turn' },
      });
      expect(recovered.get(accepted)?.state).toBe('failed');
      expect(recovered.activeMarkers().map((entry) => entry.state)).toEqual(['unknown', 'unknown']);
    } finally {
      reopened.close();
    }
  });

  it('preserves original status and receipt when reconciliation releases only its own marker', () => {
    const { store } = setup();
    const old = operationId();
    const reconciliation = operationId();
    const current = operationId();
    store.accept(old, 'turn.start', 'thread', {});
    store.dispatch(old, { threadId: 'thread', workspaceKey: 'workspace', codexEpoch: 'old' });
    store.acknowledge(old, { turnId: 'old-turn' }, 'old-turn');
    store.recover();
    store.accept(reconciliation, 'operation.reconcile', old, {});
    store.dispatch(reconciliation);
    store.reconcile(old, reconciliation);
    expect(store.get(old)).toMatchObject({
      state: 'acknowledged',
      result: { turnId: 'old-turn' },
      reconciliationDecision: 'confirmed-ended',
    });
    store.accept(current, 'turn.start', 'thread', {});
    store.dispatch(current, { threadId: 'thread', workspaceKey: 'workspace', codexEpoch: 'new' });
    store.reconcile(old, reconciliation);
    expect(store.activeForThread('thread')?.operationId).toBe(current);
  });

  it('enforces state constraints and migrates upgrades without losing intent or locks', () => {
    const ctx = setup();
    const oldFolder = join(ctx.directory, 'old-migrations');
    mkdirSync(join(oldFolder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(join(defaultMigrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const first = journal.entries[0]!;
    cpSync(join(defaultMigrationsFolder, `${first.tag}.sql`), join(oldFolder, `${first.tag}.sql`));
    writeFileSync(
      join(oldFolder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: [first] }),
    );
    const upgrade = openDatabase(join(ctx.directory, 'upgrade.sqlite'));
    try {
      migrateDatabase(upgrade.database, oldFolder);
      // The old schema intentionally predates reconciliation fields.
      upgrade.database.run(
        `INSERT INTO operations (client_operation_id, kind, target, request_digest, state, created_at, updated_at) VALUES ('old', 'turn.start', 't', 'digest', 'acknowledged', 1, 1)`,
      );
      upgrade.database.run(
        `INSERT INTO execution_markers (operation_id, thread_id, turn_id, workspace_key, codex_epoch, state, created_at) VALUES ('old', 't', 'turn', 'workspace', 'epoch', 'active', 1)`,
      );
      migrateDatabase(upgrade.database);
      migrateDatabase(upgrade.database);
      const upgraded = new OperationStore(upgrade.database);
      expect(upgraded.get('old')?.state).toBe('acknowledged');
      expect(upgraded.activeMarkers()).toHaveLength(1);
      expect(() =>
        upgrade.database
          .update(operations)
          .set({ state: 'invalid' as never })
          .where(eq(operations.clientOperationId, 'old'))
          .run(),
      ).toThrow();
    } finally {
      upgrade.close();
    }
  });

  it('does not continue migration on invalid SQL', () => {
    const ctx = setup();
    const badFolder = join(ctx.directory, 'bad-migrations');
    cpSync(fileURLToPath(new URL('../../drizzle', import.meta.url)), badFolder, {
      recursive: true,
    });
    const journal = JSON.parse(readFileSync(join(badFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    journal.entries.push({
      idx: 99,
      version: '6',
      when: Date.now() + 1000,
      tag: '9999_invalid',
      breakpoints: true,
    });
    writeFileSync(join(badFolder, 'meta', '_journal.json'), JSON.stringify(journal));
    writeFileSync(join(badFolder, '9999_invalid.sql'), 'THIS IS NOT SQL');
    expect(() => migrateDatabase(ctx.db.database, badFolder)).toThrow();
  });
});
