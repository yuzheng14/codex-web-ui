import { expect, it } from 'vitest';
import { planBetaGitHubRelease } from '../../scripts/beta-github-release.js';
import type { PackageRegistry } from '../../scripts/release-registry.js';

const old = '1'.repeat(40);
const stable = '2'.repeat(40);
const source = '3'.repeat(40);
const future = '4'.repeat(40);
const version = '0.2.1-beta.2';
const target = { version, commit: source };
const ancestor = (a: string, b: string) => a <= b;
function registry(entries: [string, string][] = []): PackageRegistry {
  return {
    name: '@covro/covro',
    versions: Object.fromEntries(
      [...entries, [version, source]].map(([v, commit]) => [
        v,
        { name: '@covro/covro', version: v, covroCommit: commit },
      ]),
    ),
    'dist-tags': {},
  };
}

it('compares source commits to choose the newer Beta or stable baseline, preferring stable on ties', () => {
  const history = registry([
    ['0.2.1-beta.1', old],
    ['0.2.0', stable],
    ['0.2.1-dev.99', source],
  ]);
  expect(planBetaGitHubRelease(target, history, ancestor)?.previous).toEqual({
    version: '0.2.0',
    commit: stable,
  });
  history.versions['0.2.1-beta.1']!.covroCommit = source;
  expect(planBetaGitHubRelease(target, history, ancestor)?.previous?.version).toBe('0.2.1-beta.1');
  history.versions['0.2.0']!.covroCommit = source;
  expect(planBetaGitHubRelease(target, history, ancestor)?.previous?.version).toBe('0.2.0');
});

it('uses the most recent source ancestor even when SemVer order differs from commit order', () => {
  const history = registry([
    ['0.2.0-beta.9', stable],
    ['0.2.1-beta.1', old],
    ['0.1.0', old],
  ]);
  expect(planBetaGitHubRelease(target, history, ancestor)?.previous?.version).toBe('0.2.0-beta.9');
});

it('excludes Dev, the current Beta, later Beta versions and future snapshots on historical retries', () => {
  const history = registry([
    ['0.1.0', old],
    ['0.2.1-beta.1', stable],
    ['0.2.1-beta.3', source],
    ['0.2.1-dev.99', source],
    ['0.3.0', future],
  ]);
  expect(planBetaGitHubRelease(target, history, ancestor)?.previous).toEqual({
    version: '0.2.1-beta.1',
    commit: stable,
  });
  history.versions['0.2.1-beta.1']!.covroCommit = future;
  expect(planBetaGitHubRelease(target, history, ancestor)?.previous?.version).toBe('0.1.0');
});

it('supports an initial Beta, stable-only history and legacy gitHead source metadata', () => {
  expect(planBetaGitHubRelease(target, registry(), ancestor)).toEqual({
    ...target,
    previous: undefined,
  });
  const history = registry([['0.2.0', stable]]);
  history.versions['0.2.0']!.gitHead = stable;
  delete history.versions['0.2.0']!.covroCommit;
  expect(planBetaGitHubRelease(target, history, ancestor)?.previous?.commit).toBe(stable);
});

it('creates no plan for an unpublished skipped Beta and refuses conflicting source identities', () => {
  const history = registry();
  delete history.versions[version];
  expect(planBetaGitHubRelease(target, history, ancestor)).toBeUndefined();
  history.versions[version] = { name: '@covro/covro', version, covroCommit: future };
  expect(() => planBetaGitHubRelease(target, history, ancestor)).toThrow('different source commit');
});

it('rejects missing or divergent baseline source identities and malformed target identities', () => {
  const history = registry([['0.2.0', stable]]);
  delete history.versions['0.2.0']!.covroCommit;
  expect(() => planBetaGitHubRelease(target, history, ancestor)).toThrow('no source commit');
  expect(() => planBetaGitHubRelease(target, registry([['0.2.0', stable]]), () => false)).toThrow(
    'diverges',
  );
  for (const invalid of ['0.2.1-dev.1', '0.2.1', '0.2.1-beta.01', '0.2.1-beta.1+build'])
    expect(() =>
      planBetaGitHubRelease({ ...target, version: invalid }, registry(), ancestor),
    ).toThrow();
  expect(() =>
    planBetaGitHubRelease({ ...target, commit: 'main' }, registry(), ancestor),
  ).toThrow();
});
