import { verifyCompatibility } from './sync-compatibility.js';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { npmPackageName } from '../src/shared/package.js';
import { compareVersions, npmTags, validVersion } from '../src/updates/registry.js';
import { releaseChannels, type ReleaseChannel } from '../src/shared/updates.js';
import { readPackageRegistry, releaseCommit, type PackageRegistry } from './release-registry.js';
import { planDevGitHubRelease } from './dev-github-release.js';

function developmentBase(current: string, firstRelease: boolean) {
  const [major, minor, patch] = current.split('-')[0]!.split('.');
  return `${major}.${minor}.${firstRelease ? patch : BigInt(patch!) + 1n}`;
}

export function releaseVersion(
  channel: ReleaseChannel,
  current: string,
  published: Iterable<string>,
  requested?: string,
  firstRelease = false,
) {
  if (!validVersion(current)) throw new Error('Invalid source package version');
  if (channel === 'stable') {
    if (requested !== current || current.includes('-'))
      throw new Error('Stable version must match the release-please package version');
    return current;
  }
  if (channel === 'beta') {
    if (!requested || !validVersion(requested) || !/^\d+\.\d+\.\d+-beta\.\d+$/.test(requested))
      throw new Error('Beta version must use X.Y.Z-beta.N');
    return requested;
  }
  const prefix = `${developmentBase(current, firstRelease)}-dev.`;
  let sequence = 0n;
  for (const version of published) {
    if (!version.startsWith(prefix)) continue;
    const first = version.split('+')[0]!.slice(prefix.length).split('.')[0]!;
    if (!validVersion(version) || !/^(0|[1-9]\d*)$/.test(first))
      throw new Error(`Cannot allocate a numeric dev sequence after ${version}`);
    const used = BigInt(first);
    if (used > sequence) sequence = used;
  }
  sequence += 1n;
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Dev sequence exceeds npm numeric comparison limits');
  return `${prefix}${sequence}`;
}

type ReleaseInput = {
  channel: ReleaseChannel;
  current: string;
  commit: string;
  mainCommit: string;
  requested?: string;
  firstRelease: boolean;
};
export function planRelease(
  input: ReleaseInput,
  history: PackageRegistry,
  isAncestor: (older: string, newer: string) => boolean,
) {
  const { channel, current, commit, mainCommit, requested, firstRelease } = input;
  const selected = history.versions[history['dist-tags'][npmTags[channel]] ?? ''];
  if (channel === 'dev') {
    if (commit !== mainCommit)
      return {
        version: selected?.version ?? current,
        skip: true,
        reason: 'Source is no longer main',
      };
    if (selected) {
      const previous = releaseCommit(selected);
      if (!previous) throw new Error('Published dev release has no source commit');
      if (previous !== commit) {
        if (isAncestor(commit, previous))
          return {
            version: selected.version,
            skip: true,
            reason: 'A newer source is already published',
          };
        if (!isAncestor(previous, commit))
          throw new Error('Published dev source diverges from main');
      }
    }
    const prefix = `${developmentBase(current, firstRelease)}-dev.`;
    const sameCommit = Object.values(history.versions)
      .filter((release) => release.version.startsWith(prefix) && releaseCommit(release) === commit)
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (sameCommit)
      return {
        version: sameCommit.version,
        skip: true,
        reason: 'This source is already published',
      };
  }
  const version = releaseVersion(
    channel,
    current,
    Object.keys(history.versions),
    requested,
    firstRelease,
  );
  const existing = history.versions[version];
  if (existing) {
    if (releaseCommit(existing) !== commit)
      throw new Error('This immutable npm version belongs to a different commit');
    return { version, skip: true, reason: 'This version is already published' };
  }
  if (selected && compareVersions(selected.version, version) > 0)
    return { version, skip: true, reason: 'A newer channel version is already published' };
  if (
    channel === 'dev' &&
    Object.keys(history.versions).some(
      (published) =>
        /^\d+\.\d+\.\d+-dev(?:[.+]|$)/.test(published) && compareVersions(published, version) > 0,
    )
  )
    return { version, skip: true, reason: 'A newer dev baseline is already published' };
  return { version, skip: false, reason: 'New release' };
}
async function main() {
  const channel = process.env.RELEASE_CHANNEL as ReleaseChannel;
  if (!releaseChannels.includes(channel)) throw new Error('Unknown release channel');
  verifyCompatibility();
  const filename = 'package.json';
  const source = JSON.parse(readFileSync(filename, 'utf8')) as {
    name: string;
    version: string;
    covroCommit?: string;
    covroChannel?: ReleaseChannel;
    covroRelease?: { runId: string; runAttempt: string };
  };
  if (source.name !== npmPackageName) throw new Error('Unexpected npm package name');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const history = await readPackageRegistry();
  const isAncestor = (older: string, newer: string) =>
    execFileSync('git', ['merge-base', older, newer], { encoding: 'utf8' }).trim() === older;
  const { version, skip, reason } = planRelease(
    {
      channel,
      current: source.version,
      commit: sha,
      mainCommit:
        channel === 'dev'
          ? execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], {
              encoding: 'utf8',
            }).trim()
          : sha,
      requested: process.env.RELEASE_VERSION,
      firstRelease: !(
        JSON.parse(readFileSync('.release-please-manifest.json', 'utf8')) as Record<string, string>
      )['.'],
    },
    history,
    isAncestor,
  );
  if (channel === 'stable') {
    const tagged = execFileSync('git', ['rev-parse', `refs/tags/v${version}^{commit}`], {
      encoding: 'utf8',
    }).trim();
    if (tagged !== sha) throw new Error('Stable publication must use its exact GitHub Release tag');
  }
  const tag = npmTags[channel];
  const devRelease =
    channel === 'dev'
      ? planDevGitHubRelease({ version, commit: sha, skip }, history, isAncestor)
      : undefined;
  if (!skip) {
    source.version = version;
    source.covroCommit = sha;
    source.covroChannel = channel;
    if (process.env.GITHUB_RUN_ID) {
      const runId = process.env.GITHUB_RUN_ID;
      const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '';
      if (![runId, runAttempt].every((value) => /^[1-9]\d*$/.test(value)))
        throw new Error('Invalid CI run identity');
      source.covroRelease = { runId, runAttempt };
    }
    writeFileSync(filename, `${JSON.stringify(source, null, 2)}\n`);
  }
  const output = `version=${version}\ntag=${tag}\nskip=${skip}\ndev_release_version=${devRelease?.version ?? ''}\ndev_base_version=${devRelease?.previous?.version ?? ''}\ndev_base_commit=${devRelease?.previous?.commit ?? ''}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  console.log(`${output}reason=${reason}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
