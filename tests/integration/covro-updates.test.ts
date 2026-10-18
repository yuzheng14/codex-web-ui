import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  activateUpdate,
  transactionPaths,
  type UpdateEffects,
} from '../../src/updates/transaction.js';
import { compareVersions, validVersion } from '../../src/updates/registry.js';
import { harness, operationId } from './domain-helpers.js';
import { paths as cliPaths, packageInfo } from '../../src/cli/paths.js';
import { UpdateManager } from '../../src/updates/manager.js';
import { saveJson } from '../../src/updates/files.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('orders immutable release versions and prereleases without treating dev as stable', () => {
  expect(compareVersions('0.3.0-dev.10', '0.3.0-dev.9')).toBeGreaterThan(0);
  expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBeLessThan(0);
  expect(compareVersions('0.3.0', '0.2.99')).toBeGreaterThan(0);
  expect(compareVersions('0.3.0+abc', '0.3.0+def')).toBe(0);
  for (const version of ['latest', '../bad', '1.2.3;sh', '1.2.3-dev.01', '01.2.3'])
    expect(validVersion(version)).toBe(false);
});

it('blocks activation for in-flight and unknown executions, then atomically rejects new work after idle admission', async () => {
  const h = harness();
  cleanups.push(h.close);
  const created = await h.service.createThread('project', { clientOperationId: operationId() });
  const id = (created.result as { threadId: string }).threadId;
  const turn = await h.service.startTurn(id, { clientOperationId: operationId(), text: 'task' });
  expect(h.service.prepareUpdate().ready).toBe(false);
  h.codex.complete(id, turn.execution!.turnId!);
  expect(h.service.prepareUpdate()).toEqual({ ready: true });
  await expect(
    h.service.startTurn(id, { clientOperationId: operationId(), text: 'must not dispatch' }),
  ).rejects.toMatchObject({ code: 'UPDATE_MAINTENANCE' });
  expect(h.codex.starts).toBe(1);
  h.service.setMaintenance(false);
  await h.service.startTurn(id, { clientOperationId: operationId(), text: 'next' });
  h.codex.reset();
  expect(h.service.prepareUpdate().ready).toBe(false);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'covro-upgrade-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = transactionPaths(
    join(root, 'npm/covro'),
    'test-update',
    join(root, 'data'),
    join(root, 'config.json'),
    join(root, 'backup'),
  );
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.candidate, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(join(paths.root, 'version'), 'old');
  await writeFile(join(paths.candidate, 'version'), 'new');
  await writeFile(paths.config, '{"dataDir":"./data"}');
  const db = new Database(join(paths.dataDir, 'app.sqlite'));
  db.exec(
    "CREATE TABLE operations (id TEXT PRIMARY KEY, state TEXT); INSERT INTO operations VALUES ('original', 'unknown')",
  );
  db.close();
  const phases: string[] = [];
  const effects: UpdateEffects = {
    waitForIdle: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    verify: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    phase: async (phase) => {
      phases.push(phase);
    },
  };
  return { paths, effects, phases };
}

it('restores the complete package and original SQLite records after a candidate migration fails', async () => {
  const { paths, effects, phases } = await fixture();
  effects.verify = async () => {
    const db = new Database(join(paths.dataDir, 'app.sqlite'));
    db.exec('ALTER TABLE operations ADD COLUMN changed TEXT; DELETE FROM operations');
    db.close();
    throw new Error('candidate failed readiness');
  };
  await expect(activateUpdate(paths, effects)).rejects.toThrow('candidate failed readiness');
  expect(await readFile(join(paths.root, 'version'), 'utf8')).toBe('old');
  const db = new Database(join(paths.dataDir, 'app.sqlite'));
  try {
    expect(db.prepare('SELECT * FROM operations').all()).toEqual([
      { id: 'original', state: 'unknown' },
    ]);
  } finally {
    db.close();
  }
  expect(phases.at(-1)).toBe('rolledBack');
  expect(effects.start).toHaveBeenLastCalledWith(false);
});

it('keeps the candidate and new data after a committed activation response is lost', async () => {
  const { paths, effects } = await fixture();
  effects.commit = async () => {
    const db = new Database(join(paths.dataDir, 'app.sqlite'));
    db.exec("INSERT INTO operations VALUES ('new-write', 'acknowledged')");
    db.close();
    throw new Error('response lost');
  };
  effects.hasCommitted = async () => true;
  await activateUpdate(paths, effects);
  expect(await readFile(join(paths.root, 'version'), 'utf8')).toBe('new');
  const db = new Database(join(paths.dataDir, 'app.sqlite'));
  try {
    expect(db.prepare('SELECT COUNT(*) AS count FROM operations').get()).toEqual({ count: 2 });
  } finally {
    db.close();
  }
  expect(effects.start).not.toHaveBeenCalledWith(false);
});

it('restarts the original service when stopping fails after the process has exited', async () => {
  const { paths, effects, phases } = await fixture();
  effects.stop = vi
    .fn()
    .mockRejectedValueOnce(new Error('service manager stop failed'))
    .mockResolvedValue(undefined);
  await expect(activateUpdate(paths, effects)).rejects.toThrow('service manager stop failed');
  expect(await readFile(join(paths.root, 'version'), 'utf8')).toBe('old');
  expect(effects.start).toHaveBeenCalledWith(false);
  expect(phases.at(-1)).toBe('rolledBack');
});

it('refuses to start an uncommitted candidate after interrupted rollback', async () => {
  const { paths } = await fixture();
  const manager = new UpdateManager(
    { ...cliPaths(paths.config), home: paths.backup },
    paths.dataDir,
  );
  const run = {
    id: operationId(),
    from: '0.0.0',
    target: packageInfo.version,
    channel: 'stable',
    phase: 'failed',
    message: 'recovery interrupted',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveJson(join(manager.context!.directory, 'run.json'), run);
  await expect(manager.activationPending()).rejects.toThrow('covro update repair');
  await saveJson(join(manager.context!.directory, 'run.json'), {
    ...run,
    from: packageInfo.version,
  });
  expect(await manager.activationPending()).toBe(false);
});
