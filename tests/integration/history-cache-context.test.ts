import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import { harness } from './domain-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
it('namespaces caches by authenticated subject, server instance, runtime and project permissions', async () => {
  const h = harness();
  cleanups.push(h.close);
  let subject: string | undefined = 'first-user';
  const config = parseConfig(
    {
      publicOrigin: ['https://covro.example.com'],
      auth: {
        mode: 'cloudflare-access',
        issuer: 'https://team.cloudflareaccess.com',
        audience: 'test',
      },
    },
    '/tmp/history-context.json',
  );
  const app = createApp({
    config,
    service: h.service,
    staticDir: '/tmp/unused',
    authenticate: async () => ({ subject }),
  });
  const read = async () => {
    const response = await app.request('/api/history-cache-context');
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response.json() as Promise<{ scope: string }>;
  };
  const first = await read();
  expect(first.scope).toMatch(/^[a-f0-9]{64}$/);
  expect(await read()).toEqual(first);
  subject = 'second-user';
  const second = await read();
  expect(second.scope).not.toBe(first.scope);
  h.codex.reset();
  const nextRuntime = await read();
  expect(nextRuntime.scope).not.toBe(second.scope);
  h.service.removeProject('project');
  expect((await read()).scope).not.toBe(nextRuntime.scope);
  subject = undefined;
  expect((await app.request('/api/history-cache-context')).status).toBe(401);
});
