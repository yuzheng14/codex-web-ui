import { afterEach, expect, it, vi } from 'vitest';
import { compareVersions } from '../../src/shared/versions.js';
import { npmPackageName } from '../../src/shared/package.js';
import { planRelease, releaseVersion } from '../../scripts/prepare-release.js';
import {
  readPackageRegistry,
  type PackageRegistry,
  type PublishedRelease,
} from '../../scripts/release-registry.js';

const older = '1'.repeat(40);
const current = '2'.repeat(40);
const newer = '3'.repeat(40);
const input = {
  channel: 'dev' as const,
  current: '0.1.0',
  commit: current,
  mainCommit: current,
  firstRelease: true,
};
const release = (version: string, commit = older): PublishedRelease => ({
  name: npmPackageName,
  version,
  covroCommit: commit,
});
function history(
  releases: PublishedRelease[] = [],
  tag = releases.at(-1)?.version,
): PackageRegistry {
  return {
    name: npmPackageName,
    versions: Object.fromEntries(releases.map((entry) => [entry.version, entry])),
    'dist-tags': tag ? { dev: tag } : {},
  };
}
const isAncestor = (a: string, b: string) => a === older && b === current;
afterEach(() => vi.unstubAllGlobals());

it('starts each development base at one and keeps it between the previous and next stable releases', () => {
  expect(releaseVersion('dev', '0.1.0', [], undefined, true)).toBe('0.1.0-dev.1');
  const next = releaseVersion('dev', '0.1.0', ['0.1.0-dev.39202054561.1']);
  expect(next).toBe('0.1.1-dev.1');
  expect(compareVersions('0.1.0', next)).toBeLessThan(0);
  expect(compareVersions(next, '0.1.1')).toBeLessThan(0);
});

it('increments the largest used sequence, including legacy CI IDs, retries, and untagged versions', () => {
  const releases = [release('0.1.0-dev.39202054561.1'), release('0.1.0-dev.1')];
  const plan = planRelease(input, history(releases), isAncestor);
  expect(plan).toMatchObject({ version: '0.1.0-dev.39202054562', skip: false });
  expect(compareVersions(releases[0]!.version, plan.version)).toBeLessThan(0);
  const next = planRelease(
    { ...input, commit: newer, mainCommit: newer },
    history([...releases, release(plan.version, current)]),
    (a, b) => a === current && b === newer,
  );
  expect(next).toMatchObject({ version: '0.1.0-dev.39202054563', skip: false });
});

it('does not use missing or moved tags as permission to reuse a published sequence', () => {
  const registry = history([release('0.1.0-dev.9'), release('0.1.0-dev.10')]);
  registry['dist-tags'] = {};
  expect(planRelease(input, registry, isAncestor).version).toBe('0.1.0-dev.11');
  expect(releaseVersion('dev', '0.1.0', ['0.1.0-dev.10+build.1'], undefined, true)).toBe(
    '0.1.0-dev.11',
  );
});

it('reuses a published snapshot for the same commit even if the dev tag points elsewhere', () => {
  const registry = history(
    [release('0.1.0-dev.1'), release('0.1.0-dev.39202054561.1', current)],
    '0.1.0-dev.1',
  );
  const expected = {
    version: '0.1.0-dev.39202054561.1',
    skip: true,
    reason: 'This source is already published',
  };
  expect(planRelease(input, registry, isAncestor)).toEqual(expected);
  expect(planRelease(input, registry, isAncestor)).toEqual(expected);
});

it('skips a delayed CI run once its source is no longer main', () => {
  const ancestry = vi.fn();
  expect(planRelease({ ...input, mainCommit: newer }, history(), ancestry)).toMatchObject({
    skip: true,
    reason: 'Source is no longer main',
  });
  expect(ancestry).not.toHaveBeenCalled();
});

it('uses covroCommit as well as gitHead to keep older source from replacing a newer dev tag', () => {
  expect(
    planRelease(
      input,
      history([release('0.1.0-dev.20', newer)]),
      (a, b) => a === current && b === newer,
    ),
  ).toMatchObject({ skip: true, reason: 'A newer source is already published' });
  expect(
    planRelease(
      input,
      history([{ name: npmPackageName, version: '0.1.0-dev.20', gitHead: current }]),
      isAncestor,
    ),
  ).toMatchObject({ version: '0.1.0-dev.20', skip: true });
});

it('refuses unknown or diverged source identity instead of advancing the dev tag', () => {
  expect(() => planRelease(input, history([release('0.1.0-dev.1')]), () => false)).toThrow(
    'diverges',
  );
  expect(() =>
    planRelease(input, history([{ name: npmPackageName, version: '0.1.0-dev.1' }]), isAncestor),
  ).toThrow('no source commit');
});

it('does not regress a channel that has already advanced to a higher release base', () => {
  expect(planRelease(input, history([release('0.2.0-dev.1')]), isAncestor)).toMatchObject({
    skip: true,
    reason: 'A newer channel version is already published',
  });
  const registry = history([release('0.2.0-dev.1')]);
  registry['dist-tags'] = {};
  expect(planRelease(input, registry, isAncestor)).toMatchObject({
    skip: true,
    reason: 'A newer dev baseline is already published',
  });
});

it('rejects nonnumeric dev sequences and numbers npm cannot compare precisely', () => {
  expect(() => releaseVersion('dev', '0.1.0', ['0.1.0-dev.preview'], undefined, true)).toThrow(
    'numeric dev sequence',
  );
  expect(() =>
    releaseVersion('dev', '0.1.0', ['0.1.0-dev.9007199254740991'], undefined, true),
  ).toThrow('numeric comparison limits');
  expect(releaseVersion('dev', '0.1.0', ['0.1.0-dev.9007199254740990'], undefined, true)).toBe(
    '0.1.0-dev.9007199254740991',
  );
});

it('keeps stable releases tied to release-please and requires explicit beta versions', () => {
  expect(releaseVersion('stable', '0.2.0', [], '0.2.0')).toBe('0.2.0');
  expect(() => releaseVersion('stable', '0.2.0', [], '0.3.0')).toThrow('Stable version');
  expect(releaseVersion('beta', '0.2.0', [], '0.3.0-beta.1')).toBe('0.3.0-beta.1');
  expect(() => releaseVersion('beta', '0.2.0', [], '0.3.0')).toThrow('Beta version');
});

it('skips immutable stable/beta retries and rejects a version owned by another commit', () => {
  for (const [channel, version] of [
    ['stable', '0.1.0'],
    ['beta', '0.1.0-beta.1'],
  ] as const) {
    const options = { ...input, channel, requested: version };
    expect(planRelease(options, history([release(version, current)]), isAncestor)).toMatchObject({
      version,
      skip: true,
    });
    expect(() => planRelease(options, history([release(version, older)]), isAncestor)).toThrow(
      'different commit',
    );
  }
});

it('reads the scoped package history, not just the current tag', async () => {
  const registry = history([release('0.1.0-dev.1')]);
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(registry)));
  vi.stubGlobal('fetch', request);
  expect(await readPackageRegistry()).toEqual(registry);
  expect(request).toHaveBeenCalledWith(
    'https://registry.npmjs.org/%40covro%2Fcovro',
    expect.objectContaining({
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    }),
  );
});

it('only treats an absent package as an empty sequence history', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
  expect(await readPackageRegistry()).toEqual(history());
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
  await expect(readPackageRegistry()).rejects.toThrow('503');
});

it('rejects conflicting package, version, commit, or tag identities', async () => {
  const good = history([release('0.1.0-dev.1')]);
  for (const metadata of [
    { ...good, name: 'another-package' },
    { ...good, versions: { '0.1.0-dev.1': release('0.1.0-dev.2') } },
    { ...good, versions: { '0.1.0-dev.1': { ...release('0.1.0-dev.1'), gitHead: newer } } },
    { ...good, 'dist-tags': { dev: '0.1.0-dev.2' } },
  ]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(metadata))));
    await expect(readPackageRegistry()).rejects.toThrow();
  }
});
