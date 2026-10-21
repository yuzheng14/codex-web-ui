import { afterEach, expect, it, vi } from 'vitest';
import { createReleaseNotesLookup } from '../../src/updates/release-notes.js';
import { releaseNotesUrl } from '../../src/shared/release-notes.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function release(version = '0.4.0', body: string | null = '## Features\n\n- New feature') {
  return { tag_name: `v${version}`, html_url: releaseNotesUrl(version), draft: false, body };
}
function upstream(value: unknown, status = 200) {
  const fetcher = vi.fn(async () => Response.json(value, { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

it.each(['0.4.0', '0.4.0-beta.2', '0.4.0-dev.9', '0.4.0+build.1'])(
  'queries only the exact published tag for %s, independently of channel names',
  async (version) => {
    const fetcher = upstream(release(version));
    expect(await createReleaseNotesLookup()(version)).toMatchObject({
      version,
      state: 'available',
      body: release(version).body,
      url: releaseNotesUrl(version),
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `https://api.github.com/repos/yuzheng14/covro/releases/tags/${encodeURIComponent(`v${version}`)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal), redirect: 'error' }),
    );
  },
);

it('deduplicates requests, caches by version, expires entries and lets retry bypass the cache', async () => {
  vi.useFakeTimers();
  const fetcher = upstream(release());
  const lookup = createReleaseNotesLookup();
  await Promise.all([lookup('0.4.0'), lookup('0.4.0')]);
  await lookup('0.4.0');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await lookup('0.4.0', true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(5 * 60_000);
  await lookup('0.4.0');
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockResolvedValueOnce(Response.json(release('0.5.0')));
  expect(await lookup('0.5.0')).toMatchObject({ version: '0.5.0', state: 'available' });
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('accepts GitHub links with unescaped build metadata for the exact tag', async () => {
  upstream({
    ...release('0.4.0+build.1'),
    html_url: 'https://github.com/yuzheng14/covro/releases/tag/v0.4.0+build.1',
  });
  expect(await createReleaseNotesLookup()('0.4.0+build.1')).toMatchObject({ state: 'available' });
});

it.each([
  [404, {}, { state: 'missing' }],
  [200, release('0.4.0', null), { state: 'empty' }],
  [200, release('0.4.0', ' \n '), { state: 'empty' }],
  [200, { ...release(), draft: true }, { state: 'missing' }],
  [403, {}, { state: 'error', reason: 'rateLimited' }],
  [429, {}, { state: 'error', reason: 'rateLimited' }],
  [500, {}, { state: 'error', reason: 'unavailable' }],
  [200, release('0.3.0'), { state: 'error', reason: 'unavailable' }],
  [
    200,
    { ...release(), html_url: 'https://attacker.example/' },
    { state: 'error', reason: 'unavailable' },
  ],
  [200, {}, { state: 'error', reason: 'unavailable' }],
  [200, release('0.4.0', 'x'.repeat(1024 * 1024)), { state: 'error', reason: 'unavailable' }],
] as const)(
  'handles upstream %s without borrowing another release',
  async (status, data, expected) => {
    upstream(data, status);
    expect(await createReleaseNotesLookup()('0.4.0')).toMatchObject({
      version: '0.4.0',
      ...expected,
    });
  },
);

it.each(['network', 'timeout', 'invalid JSON'])(
  'does not cache %s failures and can retry',
  async (failure) => {
    const fetcher = upstream(release());
    if (failure === 'invalid JSON') fetcher.mockResolvedValueOnce(new Response('{'));
    else
      fetcher.mockRejectedValueOnce(
        new DOMException(failure, failure === 'timeout' ? 'TimeoutError' : 'NetworkError'),
      );
    const lookup = createReleaseNotesLookup();
    expect(await lookup('0.4.0')).toMatchObject({ state: 'error', reason: 'unavailable' });
    expect(await lookup('0.4.0')).toMatchObject({ state: 'available' });
  },
);

it('bounds cache size and refreshes missing releases when they are published', async () => {
  const fetcher = upstream({});
  fetcher.mockImplementation(async () => Response.json({}, { status: 404 }));
  const lookup = createReleaseNotesLookup();
  for (let index = 0; index < 33; index++) await lookup(`0.4.${index}`);
  await lookup('0.4.0');
  expect(fetcher).toHaveBeenCalledTimes(34);
  fetcher.mockResolvedValueOnce(Response.json(release('0.4.0')));
  expect(await lookup('0.4.0', true)).toMatchObject({ state: 'available' });
});

it.each(['latest', '../latest', 'v0.4.0', 'https://example.com', '0.4.0\n', '0.4.0-01'])(
  'rejects invalid selectors before fetching: %s',
  async (version) => {
    const fetcher = upstream(release());
    await expect(createReleaseNotesLookup()(version)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
