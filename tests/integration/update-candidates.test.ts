import { afterEach, expect, it, vi } from 'vitest';
import { lookupRelease, npmTags } from '../../src/updates/registry.js';
import type { ReleaseChannel } from '../../src/shared/updates.js';

afterEach(() => vi.restoreAllMocks());

function registry(tags: Record<string, string | number | Error | object>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const tag = String(url).split('/').at(-1)!;
    const value = tags[tag] ?? 404;
    if (value instanceof Error) throw value;
    if (typeof value === 'number') return new Response('', { status: value });
    return new Response(
      JSON.stringify(
        typeof value === 'string'
          ? { name: '@covro/covro', version: value, gitHead: `commit-${tag}` }
          : value,
      ),
    );
  });
}

it.each([
  ['stable', '0.2.0', 'stable', ['latest']],
  ['beta', '0.2.0', 'stable', ['latest', 'beta']],
  ['dev', '0.2.0', 'stable', ['latest', 'dev']],
] as const)('%s selects only its allowed sources', async (subscription, version, source, tags) => {
  const fetch = registry({ latest: '0.2.0', beta: '0.2.0-beta.1', dev: '0.1.1-dev.8' });
  expect(await lookupRelease(subscription)).toMatchObject({
    version,
    channel: source,
    gitHead: `commit-${npmTags[source]}`,
  });
  expect(fetch.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(tags);
});

it.each([
  ['beta', '0.3.0-beta.1', '0.3.0-beta.1', 'beta'],
  ['dev', '0.3.0-dev.1', '0.3.0-dev.1', 'dev'],
  ['dev', '0.2.0-dev.99', '0.2.0', 'stable'],
  ['beta', '0.2.0+build.beta', '0.2.0', 'stable'],
] as const)(
  '%s compares %s against stable using SemVer',
  async (subscription, prerelease, version, source) => {
    registry({
      latest: '0.2.0',
      [subscription]: prerelease,
      beta: subscription === 'beta' ? prerelease : '99.0.0-beta.1',
    });
    expect(await lookupRelease(subscription)).toMatchObject({ version, channel: source });
  },
);

for (const channel of ['beta', 'dev'] as const) {
  it.each(['latest', channel])(`${channel} tolerates missing %s`, async (missing) => {
    registry({ latest: '0.2.0', [channel]: `0.3.0-${channel}.1`, [missing]: 404 });
    const source: ReleaseChannel = missing === 'latest' ? channel : 'stable';
    expect((await lookupRelease(channel)).channel).toBe(source);
  });
  for (const failing of ['latest', channel]) {
    it.each([503, new Error('network unavailable'), { name: 'other-package', version: '9.0.0' }])(
      `${channel} rejects an incomplete check when ${failing} fails: %j`,
      async (failure) => {
        registry({ latest: '0.2.0', [channel]: `0.3.0-${channel}.1`, [failing]: failure });
        await expect(lookupRelease(channel)).rejects.toThrow();
      },
    );
  }
}

it('reports an unpublished channel when every allowed tag is missing', async () => {
  registry({});
  await expect(lookupRelease('dev')).rejects.toThrow('latest、dev');
});

it('propagates cancellation rather than selecting a partial result', async () => {
  const controller = new AbortController();
  const error = new Error('cancelled');
  controller.abort(error);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    options?.signal?.throwIfAborted();
    throw new Error('Expected an aborted signal');
  });
  await expect(lookupRelease('beta', controller.signal)).rejects.toThrow('cancelled');
});
