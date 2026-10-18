import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import type { UpdateController, UpdateStatus } from '../../src/shared/updates.js';
import { harness } from './domain-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture() {
  const h = harness();
  cleanups.push(h.close);
  const status: UpdateStatus = {
    version: '0.1.0',
    source: 'npm',
    supported: true,
    settings: { channel: 'stable', automatic: false },
  };
  const updates: UpdateController = {
    status: async () => status,
    check: vi.fn(async () => status),
    configure: vi.fn(async () => status),
    start: vi.fn(async () => status),
    close: () => {},
  };
  const origin = 'http://127.0.0.1:8787';
  const app = createApp({
    config: parseConfig({}, '/tmp/config.json'),
    service: h.service,
    staticDir: h.directory,
    updates,
  });
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    app.request(origin + path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return { h, app, updates, post, origin };
}
it('protects update controls with the existing origin rules and rejects arbitrary package selectors', async () => {
  const { post, updates } = fixture();
  const input = { clientOperationId: randomUUID(), channel: 'dev' };
  expect(
    (await post('/api/updates/run', input, { origin: 'https://attacker.example' })).status,
  ).toBe(403);
  expect((await post('/api/updates/run', { ...input, package: 'other-package' })).status).toBe(400);
  expect(
    (await post('/api/updates/run', { ...input, channel: 'https://attacker.example' })).status,
  ).toBe(400);
  expect(updates.start).not.toHaveBeenCalled();
  expect((await post('/api/updates/run', input)).status).toBe(202);
  expect(updates.start).toHaveBeenCalledExactlyOnceWith(input);
});
it('keeps status available while fencing project and task mutations during activation', async () => {
  const { post, app, h, origin } = fixture();
  expect(h.service.prepareUpdate().ready).toBe(true);
  expect((await post('/api/projects', { path: h.directory })).status).toBe(503);
  expect(
    (await post('/api/projects/project/threads', { clientOperationId: randomUUID() })).status,
  ).toBe(503);
  const response = await app.request(origin + '/api/updates');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
});
