import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { releaseChannels, type ReleaseChannel } from '../src/shared/updates.js';
import { npmTags, validVersion } from '../src/updates/registry.js';
import { npmPackageName } from '../src/shared/package.js';
import { readPackageRegistry, releaseCommit } from './release-registry.js';

export async function waitForPublication(
  expected: { version: string; commit: string; channel: ReleaseChannel },
  { timeoutMs = 20 * 60_000, intervalMs = 15_000, log = console.log } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const tag = npmTags[expected.channel];
  let last = '';
  for (;;) {
    let history;
    let status = '';
    try {
      history = await readPackageRegistry();
    } catch (error) {
      status = `npm metadata unavailable: ${String(error)}`;
    }
    if (history) {
      const published = history.versions[expected.version];
      if (published && releaseCommit(published) !== expected.commit)
        throw new Error('Published version belongs to a different source commit');
      const selected = history['dist-tags'][tag];
      if (published && selected === expected.version) {
        log(`Verified ${npmPackageName}@${expected.version}, ${tag}, source ${expected.commit}`);
        return;
      }
      status = `Waiting for npm review/visibility: version=${Boolean(published)}, ${tag}=${selected ?? 'missing'}`;
    }
    if (status !== last) log((last = status));
    if (Date.now() >= deadline)
      throw new Error(
        `npm publication visibility timed out; do not assume the release failed: ${last}`,
      );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())),
    );
  }
}

async function main() {
  const source = JSON.parse(readFileSync('package.json', 'utf8')) as {
    name: string;
    version: string;
    covroCommit: string;
    covroChannel: ReleaseChannel;
  };
  if (
    source.name !== npmPackageName ||
    !validVersion(source.version) ||
    !/^[0-9a-f]{40}$/.test(source.covroCommit) ||
    !releaseChannels.includes(source.covroChannel)
  )
    throw new Error('Missing stamped release identity');
  await waitForPublication({
    version: source.version,
    commit: source.covroCommit,
    channel: source.covroChannel,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
