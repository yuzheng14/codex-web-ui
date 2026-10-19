import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const betaTag = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.(?:0|[1-9]\d*))$/;
const shaPattern = /^[0-9a-f]{40}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid GitHub event or API response');
  return value as Record<string, unknown>;
}
type BetaTarget = { tag: string; version: string; after?: string };

export function betaTarget(eventName: string, payload: unknown): BetaTarget | undefined {
  if (eventName !== 'push' && eventName !== 'release') return;
  const event = object(payload);
  let tag: string;
  if (eventName === 'push') {
    if (event.deleted) return;
    if (typeof event.ref !== 'string' || !event.ref.startsWith('refs/tags/')) return;
    tag = event.ref.slice('refs/tags/'.length);
  } else {
    if (event.action !== 'published') return;
    const release = object(event.release);
    if (release.draft) return;
    if (typeof release.tag_name !== 'string') throw new Error('Release has no tag');
    tag = release.tag_name;
  }
  if (!tag.includes('-beta')) return;
  const version = betaTag.exec(tag)?.[1];
  if (!version) throw new Error('Beta tags must use vX.Y.Z-beta.N without leading zeroes');
  if (eventName === 'push') {
    if (event.created !== true || event.forced === true)
      throw new Error('Beta tags cannot be moved; create a new version tag');
    if (typeof event.after !== 'string' || !shaPattern.test(event.after))
      throw new Error('Tag push has no valid object identity');
    return { tag, version, after: event.after };
  }
  return { tag, version };
}

type GitObject = { sha: string; type: string };
function gitObject(value: unknown): GitObject {
  const result = object(value);
  if (
    typeof result.sha !== 'string' ||
    !shaPattern.test(result.sha) ||
    typeof result.type !== 'string'
  )
    throw new Error('Invalid Git tag object identity');
  return { sha: result.sha, type: result.type };
}

export function dispatchBetaRelease(
  eventName: string,
  payload: unknown,
  repository: string,
  run: (args: string[]) => string = (args) => execFileSync('gh', args, { encoding: 'utf8' }),
) {
  const target = betaTarget(eventName, payload);
  if (!target) return;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    object(object(payload).repository).full_name !== repository
  )
    throw new Error('Beta event repository does not match this workflow');
  const api = (path: string) => object(JSON.parse(run(['api', path])));
  let reference = gitObject(
    api(`repos/${repository}/git/ref/tags/${encodeURIComponent(target.tag)}`).object,
  );
  const original = reference.sha;
  const seen = new Set<string>();
  while (reference.type === 'tag') {
    if (seen.has(reference.sha) || seen.size >= 10) throw new Error('Invalid annotated tag chain');
    seen.add(reference.sha);
    reference = gitObject(api(`repos/${repository}/git/tags/${reference.sha}`).object);
  }
  if (reference.type !== 'commit') throw new Error('Beta tag does not point to a commit');
  // GitHub can report the tag object or its peeled commit in a tag push payload.
  if (target.after && target.after !== original && target.after !== reference.sha)
    throw new Error('Beta tag moved after this event');
  run([
    'workflow',
    'run',
    'publish.yml',
    '--repo',
    repository,
    '--ref',
    'main',
    '-f',
    'channel=beta',
    '-f',
    `version=${target.version}`,
    '-f',
    `source_ref=${reference.sha}`,
  ]);
  return { tag: target.tag, version: target.version, commit: reference.sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = dispatchBetaRelease(
    process.env.GITHUB_EVENT_NAME ?? '',
    JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')),
    process.env.GITHUB_REPOSITORY ?? '',
  );
  console.log(
    result
      ? `Dispatched Beta ${result.version} from ${result.tag} (${result.commit})`
      : 'No Beta publication requested',
  );
}
