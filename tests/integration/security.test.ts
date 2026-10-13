import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { parseConfig, cliOptions } from '../../src/server/config.js';
import { createAuthenticator } from '../../src/server/auth.js';
import { acquireInstanceLock } from '../../src/server/instance-lock.js';
const local = (overrides: Record<string, unknown> = {}, development = false) =>
  parseConfig(
    { projects: [{ id: 'test', name: 'Test', path: '/tmp' }], ...overrides },
    '/tmp/config.json',
    development,
  );
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
describe('local configuration and browser boundary', () => {
  it('resolves data relative to config and supports documented pnpm separator', () => {
    expect(local().dataDir).toBe('/tmp/.local/codex-web');
    expect(cliOptions(['--', '--config', '/tmp/settings.json']).configPath).toBe(
      '/tmp/settings.json',
    );
    expect(() => cliOptions(['--config'])).toThrow('Unknown or incomplete');
  });
  it('normalizes and deduplicates an origin array, while rejecting the old string form', () => {
    expect(local().publicOrigin).toEqual(['http://127.0.0.1:8787']);
    expect(
      local({
        publicOrigin: [
          'HTTP://LOCALHOST:80/',
          'http://localhost',
          'https://Example.com:443/',
          'https://example.com',
        ],
      }).publicOrigin,
    ).toEqual(['http://localhost', 'https://example.com']);
    for (const publicOrigin of ['http://localhost:8787', [], null])
      expect(() => local({ publicOrigin })).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      );
    expect(() => local({ publicOrigins: ['http://localhost:8787'] })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });
  it('validates every configured origin before URL normalization can erase invalid components', () => {
    for (const invalid of [
      'https://*.example.com',
      'https://%2a.example.com',
      'https://example.com/path',
      'https://example.com/..',
      'https://user:password@example.com',
      'https://@example.com',
      'https://example.com?query=1',
      'https://example.com?',
      'https://example.com#fragment',
      'https://example.com#',
      'ftp://example.com',
      'https://example.com\\path',
      ' https://example.com',
    ])
      expect(() => local({ publicOrigin: ['http://127.0.0.1:8787', invalid] })).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG' }),
      );
  });
  it('allows explicit proxy origins in local mode but requires a loopback listener and dev origins', () => {
    expect(
      local({
        publicOrigin: [
          'http://127.0.0.1:8787',
          'https://proxy.example.com',
          'http://192.168.1.2:8787',
        ],
      }).publicOrigin,
    ).toEqual(['http://127.0.0.1:8787', 'https://proxy.example.com', 'http://192.168.1.2:8787']);
    expect(() =>
      parseConfig(
        { projects: [{ id: 'test', name: 'Test', path: '/tmp' }], host: '0.0.0.0' },
        '/tmp/config.json',
      ),
    ).toThrow();
    expect(() => local({ host: '100.100.100.100' })).toThrow('loopback');
    expect(() =>
      parseConfig(
        {
          projects: [{ id: 'x', name: 'x', path: '/tmp' }],
          developmentOrigins: ['https://example.com'],
        },
        '/tmp/config.json',
      ),
    ).toThrow('loopback');
  });
  it('accepts HTTP reads, mutations and WS for each explicit Host and Origin without accepting aliases', async () => {
    const configuredOrigins = [
      'http://127.0.0.1:8787',
      'http://localhost:8787',
      'https://proxy.example.com',
    ];
    const authenticate = createAuthenticator(local({ publicOrigin: configuredOrigins }));
    for (const origin of configuredOrigins) {
      await expect(authenticate(new Request(`${origin}/api/projects`))).resolves.toEqual({});
      await expect(
        authenticate(
          new Request(`${origin}/api/actions`, {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
          }),
        ),
      ).resolves.toEqual({});
      await expect(
        authenticate(new Request(`${origin}/ws`, { headers: { origin } }), true),
      ).resolves.toEqual({});
    }
    for (const origin of ['http://localhost:8788', 'https://other.example.com']) {
      await expect(
        authenticate(
          new Request(`${origin}/api/projects`, {
            headers: {
              'x-forwarded-host': 'localhost:8787',
              'tailscale-user-login': 'owner@example.com',
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_HOST' });
      for (const websocket of [false, true])
        await expect(
          authenticate(
            new Request(`http://localhost:8787/${websocket ? 'ws' : 'api/actions'}`, {
              method: websocket ? 'GET' : 'POST',
              headers: { origin, 'content-type': 'application/json' },
            }),
            websocket,
          ),
        ).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
    }
  });
  it('enables explicitly configured development origins only with the development flag', async () => {
    const origin = 'http://127.0.0.1:5173';
    for (const development of [false, true]) {
      const config = local({ developmentOrigins: [origin] }, development);
      expect(config.developmentOrigins).toEqual(development ? [origin] : []);
      const authenticate = createAuthenticator(config);
      const request = new Request('http://127.0.0.1:8787/ws', { headers: { origin } });
      if (development) {
        await expect(authenticate(request, true)).resolves.toEqual({});
        await expect(authenticate(new Request(`${origin}/api/projects`))).resolves.toEqual({});
      } else {
        await expect(authenticate(request, true)).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
        await expect(authenticate(new Request(`${origin}/api/projects`))).rejects.toMatchObject({
          code: 'INVALID_HOST',
        });
      }
    }
  });
  it('blocks DNS rebinding, cross-origin mutation and WS, and non-JSON actions', async () => {
    const authenticate = createAuthenticator(local());
    await expect(authenticate(new Request('http://evil.test/api/projects'))).rejects.toMatchObject({
      code: 'INVALID_HOST',
    });
    await expect(
      authenticate(
        new Request('http://127.0.0.1:8787/api/x', {
          method: 'POST',
          headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
    await expect(authenticate(new Request('http://127.0.0.1:8787/ws'), true)).rejects.toMatchObject(
      { code: 'INVALID_ORIGIN' },
    );
    await expect(
      authenticate(
        new Request('http://127.0.0.1:8787/api/x', {
          method: 'POST',
          headers: { origin: 'http://127.0.0.1:8787', 'content-type': 'text/plain' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT_TYPE' });
    await expect(
      authenticate(
        new Request('http://127.0.0.1:8787/ws', { headers: { origin: 'http://127.0.0.1:8787' } }),
        true,
      ),
    ).resolves.toEqual({});
  });
  it('enforces one instance including migration and releases cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-lock-'));
    directories.push(dir);
    const release = await acquireInstanceLock(dir);
    try {
      await expect(acquireInstanceLock(dir)).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      await release();
    }
    const secondRelease = await acquireInstanceLock(dir);
    await secondRelease();
  });
});
describe('Cloudflare Access verification', () => {
  it('requires HTTPS for every Access public origin', () => {
    expect(() =>
      local({
        publicOrigin: ['https://codex.example.com', 'http://localhost:8787'],
        auth: {
          mode: 'cloudflare-access',
          issuer: 'https://team.cloudflareaccess.com',
          audience: 'app-aud',
        },
      }),
    ).toThrow('HTTPS');
  });
  it('requires a verified JWT for HTTP reads, mutations and WS at every configured origin', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicOrigin = ['https://codex.example.com', 'https://second.example.com'];
    const authenticate = createAuthenticator(
      local({
        publicOrigin,
        auth: {
          mode: 'cloudflare-access',
          issuer: 'https://team.cloudflareaccess.com',
          audience: 'app-aud',
        },
      }),
      publicKey,
    );
    const token = await new SignJWT({ sub: 'owner' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://team.cloudflareaccess.com')
      .setAudience('app-aud')
      .setExpirationTime('1h')
      .sign(privateKey);
    for (const origin of publicOrigin) {
      for (const kind of ['read', 'write', 'websocket']) {
        const request = (jwt?: string) =>
          new Request(`${origin}/${kind === 'websocket' ? 'ws' : 'api/projects'}`, {
            method: kind === 'write' ? 'POST' : 'GET',
            headers: {
              origin,
              'content-type': 'application/json',
              'x-forwarded-user': 'owner',
              'tailscale-user-login': 'owner@example.com',
              ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}),
            },
          });
        await expect(authenticate(request(), kind === 'websocket')).rejects.toMatchObject({
          code: 'UNAUTHENTICATED',
        });
        await expect(authenticate(request('invalid'), kind === 'websocket')).rejects.toMatchObject({
          code: 'UNAUTHENTICATED',
        });
        await expect(authenticate(request(token), kind === 'websocket')).resolves.toHaveProperty(
          'expiresAt',
        );
      }
    }
  });
  it('requires trusted issuer, audience, signature, expiry and nbf on HTTP and upgrades', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const config = parseConfig(
      {
        projects: [{ id: 'x', name: 'X', path: '/tmp' }],
        publicOrigin: ['https://codex.example.com'],
        auth: {
          mode: 'cloudflare-access',
          issuer: 'https://team.cloudflareaccess.com',
          audience: 'app-aud',
        },
      },
      '/tmp/config.json',
    );
    const authenticate = createAuthenticator(config, publicKey);
    const token = async (
      changes: { aud?: string; issuer?: string; exp?: number; nbf?: number } = {},
    ) =>
      new SignJWT({ sub: 'owner', ...(changes.nbf ? { nbf: changes.nbf } : {}) })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(changes.issuer ?? 'https://team.cloudflareaccess.com')
        .setAudience(changes.aud ?? 'app-aud')
        .setExpirationTime(changes.exp ?? Math.floor(Date.now() / 1000) + 60)
        .sign(privateKey);
    const request = (jwt?: string) =>
      new Request('https://codex.example.com/ws', {
        headers: {
          origin: 'https://codex.example.com',
          ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}),
        },
      });
    await expect(authenticate(request(await token()), true)).resolves.toHaveProperty('expiresAt');
    for (const invalid of [
      undefined,
      await token({ aud: 'other' }),
      await token({ exp: 1 }),
      await token({ nbf: Math.floor(Date.now() / 1000) + 500 }),
      (await token()).slice(0, -12) + 'XXXXXXXXXXXX',
    ]) {
      await expect(authenticate(request(invalid), true)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    }
    const wrongIssuer = await new SignJWT({ sub: 'owner' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://attacker.cloudflareaccess.com')
      .setAudience('app-aud')
      .setExpirationTime('1h')
      .sign(privateKey);
    await expect(authenticate(request(wrongIssuer))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});
