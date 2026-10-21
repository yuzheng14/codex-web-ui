import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { compareVersions, validVersion } from '../src/shared/versions.js';
import { readPackageRegistry, releaseCommit, type PackageRegistry } from './release-registry.js';
import {
  devVersion,
  stableVersion,
  prereleasePlanSchema as planSchema,
  publishGitHubPrerelease,
  githubApi,
  type Ancestor,
  type PrereleasePlan,
} from './github-prerelease.js';

export type DevReleasePlan = PrereleasePlan;
export type { GitHubApi } from './github-prerelease.js';
export const publishDevGitHubRelease = publishGitHubPrerelease.bind(null, 'dev');

export function planDevGitHubRelease(
  input: { version: string; commit: string; skip: boolean },
  history: PackageRegistry,
  isAncestor: Ancestor,
): DevReleasePlan | undefined {
  // A skipped npm retry can still repair its own missing GitHub Release, even after main advances.
  const version = input.skip
    ? Object.values(history.versions)
        .filter((entry) => devVersion.test(entry.version) && releaseCommit(entry) === input.commit)
        .sort((a, b) => compareVersions(b.version, a.version))[0]?.version
    : input.version;
  if (!version) return;
  if (!validVersion(version) || !devVersion.test(version)) throw new Error('Invalid Dev version');

  function previous(channel: 'dev' | 'stable') {
    const kind = channel === 'dev' ? devVersion : stableVersion;
    const entries = Object.values(history.versions)
      .filter(
        (entry) =>
          kind.test(entry.version) &&
          (channel === 'stable' || compareVersions(entry.version, version!) < 0),
      )
      .sort((a, b) => compareVersions(b.version, a.version));
    for (const entry of entries) {
      const commit = releaseCommit(entry);
      if (!commit) throw new Error(`Release ${entry.version} has no source commit`);
      if (commit === input.commit || isAncestor(commit, input.commit))
        return { version: entry.version, commit };
      // On a retry, newer stable publications may already be ahead of this snapshot.
      if (!isAncestor(input.commit, commit))
        throw new Error(`Release ${entry.version} diverges from source`);
    }
  }
  const dev = previous('dev');
  const stable = previous('stable');
  let base = dev ?? stable;
  if (dev && stable) {
    if (dev.commit === stable.commit || isAncestor(dev.commit, stable.commit)) base = stable;
    else if (!isAncestor(stable.commit, dev.commit)) throw new Error('Release baselines diverge');
  }
  return planSchema.parse({ version, commit: input.commit, previous: base });
}

async function main() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const previousVersion = process.env.DEV_BASE_VERSION ?? '';
  const previousCommit = process.env.DEV_BASE_COMMIT ?? '';
  const plan = planSchema.parse({
    version: process.env.DEV_RELEASE_VERSION,
    commit,
    previous:
      previousVersion || previousCommit
        ? { version: previousVersion, commit: previousCommit }
        : undefined,
  });
  const history = await readPackageRegistry();
  console.log(
    publishDevGitHubRelease(
      process.env.GITHUB_REPOSITORY ?? '',
      plan,
      history,
      (older, newer) =>
        execFileSync('git', ['merge-base', older, newer], { encoding: 'utf8' }).trim() === older,
      githubApi,
      JSON.parse(execFileSync('git', ['show', `${commit}:package.json`], { encoding: 'utf8' }))
        .covroDatabase,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
