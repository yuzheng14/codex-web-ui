import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compareVersions, npmTags, registry, validVersion } from '../src/updates/registry.js';
import { releaseChannels, type ReleaseChannel } from '../src/shared/updates.js';

export function releaseVersion(
  channel: ReleaseChannel,
  current: string,
  sequence: string,
  attempt: string,
  requested?: string,
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
  if (!/^[1-9]\d*$/.test(sequence) || !/^[1-9]\d*$/.test(attempt))
    throw new Error('Invalid CI run identity');
  const [major, minor, patch] = current.split('-')[0]!.split('.');
  return `${major}.${minor}.${BigInt(patch!) + 1n}-dev.${sequence}.${attempt}`;
}

async function metadata(selector: string) {
  const response = await fetch(`${registry}/covro/${selector}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm metadata failed: ${response.status}`);
  return (await response.json()) as { version: string; gitHead?: string; covroCommit?: string };
}
async function main() {
  const channel = process.env.RELEASE_CHANNEL as ReleaseChannel;
  if (!releaseChannels.includes(channel)) throw new Error('Unknown release channel');
  const filename = 'package.json';
  const source = JSON.parse(readFileSync(filename, 'utf8')) as {
    name: string;
    version: string;
    covroCommit?: string;
    covroChannel?: ReleaseChannel;
  };
  if (source.name !== 'covro') throw new Error('Unexpected npm package name');
  const version = releaseVersion(
    channel,
    source.version,
    process.env.RELEASE_SEQUENCE ?? '',
    process.env.RELEASE_ATTEMPT ?? '',
    process.env.RELEASE_VERSION,
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (channel === 'stable') {
    const tagged = execFileSync('git', ['rev-parse', `refs/tags/v${version}^{commit}`], {
      encoding: 'utf8',
    }).trim();
    if (tagged !== sha) throw new Error('Stable publication must use its exact GitHub Release tag');
  }
  const tag = npmTags[channel];
  const [existing, selected] = await Promise.all([metadata(version), metadata(tag)]);
  let skip = false;
  if (existing) {
    if ((existing.covroCommit ?? existing.gitHead) !== sha)
      throw new Error('This immutable npm version belongs to a different commit');
    skip = true;
  }
  if (selected && compareVersions(selected.version, version) > 0) skip = true;
  if (channel === 'dev' && selected?.gitHead) {
    const old = execFileSync('git', ['merge-base', sha, selected.gitHead], {
      encoding: 'utf8',
    }).trim();
    if (old === sha && selected.gitHead !== sha) skip = true;
  }
  if (!skip) {
    source.version = version;
    source.covroCommit = sha;
    source.covroChannel = channel;
    writeFileSync(filename, `${JSON.stringify(source, null, 2)}\n`);
  }
  const output = `version=${version}\ntag=${tag}\nskip=${skip}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  console.log(output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
