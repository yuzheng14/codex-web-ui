import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { parseConfig, cliOptions } from '../../src/server/config.js';
import { createAuthenticator } from '../../src/server/auth.js';
import { acquireInstanceLock } from '../../src/server/instance-lock.js';
const local = () =>
  parseConfig({ projects: [{ id: 'test', name: 'Test', path: '/tmp' }] }, '/tmp/config.json');
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
  it('rejects public local mode and non-loopback dev origins', () => {
    expect(() =>
      parseConfig(
        { projects: [{ id: 'test', name: 'Test', path: '/tmp' }], host: '0.0.0.0' },
        '/tmp/config.json',
      ),
    ).toThrow();
    expect(() =>
      parseConfig(
        { projects: [{ id: 'x', name: 'x', path: '/tmp' }], publicOrigin: 'https://example.com' },
        '/tmp/config.json',
      ),
    ).toThrow('loopback');
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
  it('requires trusted issuer, audience, signature, expiry and nbf on HTTP and upgrades', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const config = parseConfig(
      {
        projects: [{ id: 'x', name: 'X', path: '/tmp' }],
        publicOrigin: 'https://codex.example.com',
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
