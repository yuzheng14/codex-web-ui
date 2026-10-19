import { afterEach, expect, it, vi } from 'vitest';
import { npmPackageName } from '../../src/shared/package.js';
import { waitForPublication } from '../../scripts/verify-published-release.js';

const commit = '1'.repeat(40);
const version = '0.1.0-dev.39202054562';
const expected = { version, commit, channel: 'dev' as const };
function registry(visible: boolean, tag = '0.1.0-dev.1', source = commit) {
  const versions = {
    '0.1.0-dev.1': { name: npmPackageName, version: '0.1.0-dev.1', covroCommit: commit },
    ...(visible ? { [version]: { name: npmPackageName, version, covroCommit: source } } : {}),
  };
  return new Response(
    JSON.stringify({ name: npmPackageName, versions, 'dist-tags': { dev: tag } }),
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('holds the publication until npm review and tag visibility both finish', async () => {
  vi.useFakeTimers();
  const request = vi
    .fn()
    .mockResolvedValueOnce(registry(false))
    .mockResolvedValueOnce(registry(true))
    .mockResolvedValueOnce(registry(true, version));
  vi.stubGlobal('fetch', request);
  const log = vi.fn();
  let complete = false;
  const waiting = waitForPublication(expected, { timeoutMs: 3000, intervalMs: 1000, log }).then(
    () => {
      complete = true;
    },
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  await waiting;
  expect(complete).toBe(true);
  expect(request).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenLastCalledWith(
    expect.stringContaining(`Verified ${npmPackageName}@${version}, dev, source ${commit}`),
  );
});

it('retries transient registry errors instead of treating them as an empty history', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(registry(true, version)),
  );
  const waiting = waitForPublication(expected, { timeoutMs: 2000, intervalMs: 1000, log: vi.fn() });
  await vi.advanceTimersByTimeAsync(1000);
  await waiting;
});

it('fails if a visible immutable version has the wrong source identity', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(registry(true, version, '2'.repeat(40))));
  await expect(waitForPublication(expected, { log: vi.fn() })).rejects.toThrow(
    'different source commit',
  );
});

it('fails visibly when npm review or tag propagation exceeds the deadline', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(registry(true))),
  );
  const waiting = expect(
    waitForPublication(expected, { timeoutMs: 2000, intervalMs: 1000, log: vi.fn() }),
  ).rejects.toThrow('do not assume the release failed');
  await vi.advanceTimersByTimeAsync(2000);
  await waiting;
});
