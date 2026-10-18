import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigStore } from '../../src/server/config-store.js';
import { loadConfig, parseConfig, parseFileConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/http.js';
import type { GatewayService } from '../../src/server/service.js';

vi.mock('node:fs/promises', { spy: true });

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'covro-config-'));
  roots.push(root);
  const path = join(root, 'config.json');
  const original = {
    dataDir: './data',
    developmentOrigins: ['http://localhost:5173'],
    projects: [{ id: 'seed', name: 'Seed', path: root }],
  };
  await writeFile(path, JSON.stringify(original));
  const running = await loadConfig({ configPath: path, development: false });
  return { root, path, original, running, store: new ConfigStore(running) };
}

it('preserves file values while showing effective values and only applies edits after restart', async () => {
  const { store, path, running } = await setup();
  const initial = await store.snapshot();
  expect(initial).toMatchObject({
    saved: { dataDir: './data', developmentOrigins: ['http://localhost:5173'] },
    running: { developmentOrigins: [] },
    restartRequired: false,
    writable: true,
  });
  const next = structuredClone(initial.saved);
  next.codex.requestTimeoutMs = 12000;
  const saved = await store.save({ config: next, revision: initial.revision });
  expect(saved.restartRequired).toBe(true);
  expect(saved.running.codex.requestTimeoutMs).toBe(30000);
  expect(running.codex.requestTimeoutMs).toBe(30000);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(next);
  const restarted = new ConfigStore(await loadConfig({ configPath: path, development: false }));
  expect(await restarted.snapshot()).toMatchObject({
    restartRequired: false,
    running: { codex: { requestTimeoutMs: 12000 } },
  });
});

it('rejects stale saves from both other pages and external editors without overwriting', async () => {
  const { store, path } = await setup();
  const initial = await store.snapshot();
  const first = { ...initial.saved, port: 9000 };
  await store.save({ revision: initial.revision, config: first });
  await expect(
    store.save({ revision: initial.revision, config: { ...initial.saved, port: 9001 } }),
  ).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
  const current = await store.snapshot();
  await writeFile(path, `${JSON.stringify(first)}\n\n`);
  await expect(
    store.save({ revision: current.revision, config: current.saved }),
  ).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
  expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify(first)}\n\n`);
});

it('serializes concurrent saves so one wins and leaves no temporary files', async () => {
  const { store, root } = await setup();
  const initial = await store.snapshot();
  const results = await Promise.allSettled(
    [9001, 9002].map((port) =>
      store.save({ revision: initial.revision, config: { ...initial.saved, port } }),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected?.status === 'rejected' && rejected.reason.code).toMatch(
    /^CONFIG_(BUSY|CONFLICT)$/,
  );
  expect((await readdir(root)).sort()).toEqual(['config.json']);
});

it('previews imports with full validation and preserves local data and project seeds', async () => {
  const { store, original, path } = await setup();
  const before = await readFile(path, 'utf8');
  const imported = await store.previewImport({
    config: { port: 9000, dataDir: '/other/data', projects: [] },
  });
  expect(imported).toMatchObject({
    config: { port: 9000, dataDir: original.dataDir, projects: original.projects },
    preserved: ['dataDir', 'projects'],
  });
  expect(await readFile(path, 'utf8')).toBe(before);
  for (const config of [
    { unknown: true },
    { port: 0 },
    { host: '0.0.0.0' },
    { publicOrigin: ['http://localhost/path'] },
    { developmentOrigins: ['https://remote.test'] },
    { codex: { home: 'relative' } },
  ])
    await expect(store.previewImport({ config })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  expect(await store.export()).toEqual(parseFileConfig(original));
});

it('protects data directory and projects even when a client bypasses the form', async () => {
  const { store, path } = await setup();
  const initial = await store.snapshot();
  const before = await readFile(path, 'utf8');
  for (const config of [
    { ...initial.saved, dataDir: '/other' },
    { ...initial.saved, projects: [] },
  ])
    await expect(store.save({ revision: initial.revision, config })).rejects.toMatchObject({
      code: 'CONFIG_PROTECTED',
    });
  expect(await readFile(path, 'utf8')).toBe(before);
});

it('leaves the original file intact and releases the lock after a failed write', async () => {
  const { store, path, root } = await setup();
  const initial = await store.snapshot();
  const before = await readFile(path, 'utf8');
  const failure = vi.spyOn(files, 'open').mockRejectedValueOnce(new Error('disk full'));
  try {
    await expect(
      store.save({ revision: initial.revision, config: { ...initial.saved, port: 9000 } }),
    ).rejects.toMatchObject({ code: 'CONFIG_WRITE_FAILED' });
  } finally {
    failure.mockRestore();
  }
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(await readdir(root)).toEqual(['config.json']);
  await expect(
    store.save({ revision: initial.revision, config: initial.saved }),
  ).resolves.toMatchObject({ restartRequired: false });
});

it('handles symlinked, missing, invalid and oversized configurations without writing them', async () => {
  const { store, path, root, original } = await setup();
  const link = join(root, 'linked.json');
  await symlink(path, link);
  const linked = new ConfigStore(parseConfig(original, link));
  const snapshot = await linked.snapshot();
  expect(snapshot.writable).toBe(false);
  await expect(
    linked.save({ revision: snapshot.revision, config: snapshot.saved }),
  ).rejects.toMatchObject({ code: 'CONFIG_READ_ONLY' });
  await writeFile(path, '{bad json');
  await expect(store.snapshot()).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  await writeFile(path, ' '.repeat(256 * 1024 + 1));
  await expect(store.snapshot()).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  await rm(path);
  await expect(store.snapshot()).rejects.toMatchObject({ code: 'CONFIG_READ_FAILED' });
});

it('keeps Access origin and authentication requirements consistent on import', async () => {
  const { store } = await setup();
  const config = {
    host: '0.0.0.0',
    auth: {
      mode: 'cloudflare-access',
      issuer: 'https://team.cloudflareaccess.com/',
      audience: 'test-aud',
    },
    publicOrigin: ['https://covro.test/'],
  };
  expect((await store.previewImport({ config })).config.auth).toMatchObject({
    issuer: 'https://team.cloudflareaccess.com',
  });
  await expect(
    store.previewImport({ config: { ...config, publicOrigin: ['http://covro.test'] } }),
  ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
});

it('authenticates config APIs, disables caching, validates bodies, and exports compatible JSON', async () => {
  const { running } = await setup();
  // Configuration routes do not need the Codex process or the conversation service.
  const app = createApp({
    config: running,
    service: { isInMaintenance: () => false } as GatewayService,
    staticDir: process.cwd(),
  });
  const get = (path: string) => app.request(`http://127.0.0.1:8787${path}`);
  const post = (path: string, body: unknown, origin = 'http://127.0.0.1:8787') =>
    app.request(`http://127.0.0.1:8787${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const initial = await get('/api/config');
  expect(initial.headers.get('cache-control')).toBe('no-store');
  const snapshot = await initial.json();
  expect((await post('/api/config/import', { config: {} }, 'https://foreign.test')).status).toBe(
    403,
  );
  expect((await app.request('http://foreign.test/api/config')).status).toBe(403);
  expect((await post('/api/config', { config: {} })).status).toBe(400);
  expect((await post('/api/config/import', { config: {}, path: '/tmp/other.json' })).status).toBe(
    400,
  );
  const updated = { ...snapshot.saved, port: 9999 };
  const saved = await post('/api/config', { revision: snapshot.revision, config: updated });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    restartRequired: true,
    saved: { port: 9999 },
    running: { port: 8787 },
  });
  // The old host/origin policy remains in force until the gateway restarts.
  expect((await get('/api/config')).status).toBe(200);
  const exported = await get('/api/config/export');
  expect(exported.headers.get('content-disposition')).toContain('codex-web-config.json');
  expect(exported.headers.get('cache-control')).toBe('no-store');
  expect(await exported.json()).toEqual(updated);
});
