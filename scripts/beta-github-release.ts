import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { compareVersions } from '../src/shared/versions.js';
import { readPackageRegistry, releaseCommit, type PackageRegistry } from './release-registry.js';
import {
  betaVersion,
  stableVersion,
  prereleasePlanSchema,
  publishGitHubPrerelease,
  githubApi,
  type Ancestor,
  type PrereleasePlan,
} from './github-prerelease.js';

export function planBetaGitHubRelease(
  input: { version: string; commit: string },
  history: PackageRegistry,
  isAncestor: Ancestor,
): PrereleasePlan | undefined {
  const target = prereleasePlanSchema.parse(input);
  if (!betaVersion.test(target.version)) throw new Error('Invalid Beta version');
  const published = history.versions[target.version];
  // npm may have skipped an unused version older than the current Beta channel.
  if (!published) return;
  if (releaseCommit(published) !== target.commit)
    throw new Error('Published Beta version belongs to a different source commit');

  const candidates = Object.values(history.versions)
    .filter(
      (entry) =>
        stableVersion.test(entry.version) ||
        (betaVersion.test(entry.version) && compareVersions(entry.version, target.version) < 0),
    )
    .sort((a, b) => compareVersions(b.version, a.version));
  let previous: PrereleasePlan['previous'];
  for (const entry of candidates) {
    const commit = releaseCommit(entry);
    if (!commit) throw new Error(`Release ${entry.version} has no source commit`);
    if (commit !== target.commit && !isAncestor(commit, target.commit)) {
      // Historical promotions/retries must not compare against a later source snapshot.
      if (isAncestor(target.commit, commit)) continue;
      throw new Error(`Release ${entry.version} diverges from source`);
    }
    if (
      !previous ||
      (previous.commit !== commit && isAncestor(previous.commit, commit)) ||
      (previous.commit === commit &&
        stableVersion.test(entry.version) &&
        !stableVersion.test(previous.version))
    )
      previous = { version: entry.version, commit };
    else if (previous.commit !== commit && !isAncestor(commit, previous.commit))
      throw new Error('Release baselines diverge');
  }
  return { ...target, previous };
}

async function main() {
  const sourceRef = process.env.BETA_SOURCE_REF;
  if (!sourceRef) throw new Error('Missing Beta source ref');
  const commit = execFileSync(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${sourceRef}^{commit}`],
    {
      encoding: 'utf8',
    },
  ).trim();
  execFileSync('git', ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);
  const history = await readPackageRegistry();
  const isAncestor: Ancestor = (older, newer) =>
    execFileSync('git', ['merge-base', older, newer], { encoding: 'utf8' }).trim() === older;
  const plan = planBetaGitHubRelease(
    { version: process.env.BETA_RELEASE_VERSION ?? '', commit },
    history,
    isAncestor,
  );
  if (!plan) {
    console.log('No published Beta version to create a GitHub prerelease for');
    return;
  }
  const metadata = JSON.parse(
    execFileSync('git', ['show', `${commit}:package.json`], { encoding: 'utf8' }),
  ) as { covroDatabase?: unknown; covroCodex?: unknown };
  console.log(
    publishGitHubPrerelease(
      'beta',
      process.env.GITHUB_REPOSITORY ?? '',
      plan,
      history,
      isAncestor,
      githubApi,
      metadata.covroDatabase,
      metadata.covroCodex,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
