import { databaseCompatibilitySchema } from '../src/shared/database.js';
import { releaseDatabaseNotes } from './release-compatibility.js';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { compareVersions, validVersion } from '../src/shared/versions.js';
import { readPackageRegistry, releaseCommit, type PackageRegistry } from './release-registry.js';

const devVersion = /^\d+\.\d+\.\d+-dev(?:\.\d+)+(?:\+[0-9A-Za-z.-]+)?$/;
const stableVersion = /^\d+\.\d+\.\d+$/;
const identity = z.object({
  version: z
    .string()
    .refine(validVersion)
    .refine((value) => devVersion.test(value) || stableVersion.test(value)),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});
const planSchema = identity.extend({ previous: identity.optional() });
export type DevReleasePlan = z.infer<typeof planSchema>;
type Ancestor = (older: string, newer: string) => boolean;

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

export type GitHubApi = (
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
) => unknown;
const gitObject = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), type: z.string() });
const releaseSchema = z.object({
  tag_name: z.string(),
  prerelease: z.boolean(),
  draft: z.boolean(),
  html_url: z.string().url(),
});

export function publishDevGitHubRelease(
  repository: string,
  input: DevReleasePlan,
  history: PackageRegistry,
  isAncestor: Ancestor,
  api: GitHubApi,
  database: unknown,
) {
  if (
    !/^[a-z\d][a-z\d-]*\/[\w.-]+$/i.test(repository) ||
    ['.', '..'].includes(repository.split('/')[1] ?? '')
  )
    throw new Error('Invalid repository');
  const plan = planSchema.parse(input);
  const contract = databaseCompatibilitySchema.parse(database);
  if (!devVersion.test(plan.version) || plan.previous?.version === plan.version)
    throw new Error('Invalid Dev release plan');
  for (const target of [plan, ...(plan.previous ? [plan.previous] : [])]) {
    const published = history.versions[target.version];
    if (!published || releaseCommit(published) !== target.commit)
      throw new Error(`npm has not published ${target.version} from the expected source commit`);
    if (target.commit !== plan.commit && !isAncestor(target.commit, plan.commit))
      throw new Error('Dev release baseline is not an ancestor of source');
  }
  const root = `repos/${repository}`;
  const tag = `v${plan.version}`;

  function tagCommit(name: string): string | undefined {
    const value = api('GET', `${root}/git/ref/tags/${name}`);
    if (value === undefined) return;
    let object = z.object({ object: gitObject }).parse(value).object;
    const seen = new Set<string>();
    while (object.type === 'tag') {
      if (seen.has(object.sha) || seen.size >= 10) throw new Error('Invalid annotated tag chain');
      seen.add(object.sha);
      object = z
        .object({ object: gitObject })
        .parse(api('GET', `${root}/git/tags/${object.sha}`)).object;
    }
    if (object.type !== 'commit') throw new Error('Release tag does not point to a commit');
    return object.sha;
  }
  function checkTag(name: string, commit: string) {
    const actual = tagCommit(name);
    if (actual && actual !== commit)
      throw new Error(`Tag ${name} belongs to a different source commit`);
    return actual;
  }
  function ensureTag(name: string, commit: string) {
    if (checkTag(name, commit)) return;
    try {
      api('POST', `${root}/git/refs`, { ref: `refs/tags/${name}`, sha: commit });
    } catch (error) {
      if (!checkTag(name, commit)) throw error;
    }
    if (!checkTag(name, commit)) throw new Error(`Tag ${name} was not created`);
  }
  function existingRelease() {
    const value = api('GET', `${root}/releases/tags/${tag}`);
    if (value === undefined) return;
    const release = releaseSchema.parse(value);
    if (
      release.tag_name !== tag ||
      !release.prerelease ||
      release.draft ||
      !checkTag(tag, plan.commit)
    )
      throw new Error('Existing Dev Release does not match a published prerelease');
    return release.html_url;
  }

  checkTag(tag, plan.commit);
  const existing = existingRelease();
  if (existing) return existing; // Preserve already-published notes, including manual edits.
  if (plan.previous) ensureTag(`v${plan.previous.version}`, plan.previous.commit);
  const notes = z.object({ body: z.string() }).parse(
    api('POST', `${root}/releases/generate-notes`, {
      tag_name: tag,
      target_commitish: plan.commit,
      ...(plan.previous ? { previous_tag_name: `v${plan.previous.version}` } : {}),
    }),
  );
  ensureTag(tag, plan.commit);
  try {
    const release = releaseSchema.parse(
      api('POST', `${root}/releases`, {
        tag_name: tag,
        target_commitish: plan.commit,
        name: tag,
        body: releaseDatabaseNotes(notes.body, contract),
        draft: false,
        prerelease: true,
        make_latest: 'false',
      }),
    );
    if (release.tag_name !== tag || !release.prerelease || release.draft)
      throw new Error('GitHub did not create the expected Dev prerelease');
    return release.html_url;
  } catch (error) {
    const created = existingRelease();
    if (created) return created;
    throw error;
  }
}

function githubApi(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])], {
        encoding: 'utf8',
        input: body ? JSON.stringify(body) : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    if (method === 'GET' && /\(HTTP 404\)/.test(String((error as { stderr?: unknown }).stderr)))
      return;
    throw error;
  }
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
