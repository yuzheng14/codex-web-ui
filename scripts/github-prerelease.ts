import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { compareVersions, validVersion } from '../src/shared/versions.js';
import { releaseCommit, type PackageRegistry } from './release-registry.js';
import { databaseCompatibilitySchema } from '../src/shared/database.js';
import { codexCompatibilitySchema } from '../src/shared/codex-compatibility.js';
import { releaseCompatibilityNotes, releaseDatabaseNotes } from './release-compatibility.js';

export const devVersion = /^\d+\.\d+\.\d+-dev(?:\.\d+)+(?:\+[0-9A-Za-z.-]+)?$/;
export const betaVersion = /^\d+\.\d+\.\d+-beta\.\d+$/;
export const stableVersion = /^\d+\.\d+\.\d+$/;
const identity = z.object({
  version: z
    .string()
    .refine(validVersion)
    .refine(
      (value) => devVersion.test(value) || betaVersion.test(value) || stableVersion.test(value),
    ),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});
export const prereleasePlanSchema = identity.extend({ previous: identity.optional() });
export type PrereleasePlan = z.infer<typeof prereleasePlanSchema>;
export type Ancestor = (older: string, newer: string) => boolean;

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

export function publishGitHubPrerelease(
  channel: 'dev' | 'beta',
  repository: string,
  input: PrereleasePlan,
  history: PackageRegistry,
  isAncestor: Ancestor,
  api: GitHubApi,
  database: unknown,
  codex?: unknown,
) {
  if (
    !/^[a-z\d][a-z\d-]*\/[\w.-]+$/i.test(repository) ||
    ['.', '..'].includes(repository.split('/')[1] ?? '')
  )
    throw new Error('Invalid repository');
  const plan = prereleasePlanSchema.parse(input);
  // Older Beta snapshots predate this declaration; never borrow main's database contract.
  const contract =
    channel === 'beta' && database === undefined
      ? undefined
      : databaseCompatibilitySchema.parse(database);
  const compatibility = channel === 'beta' ? codexCompatibilitySchema.parse(codex) : undefined;
  const kind = channel === 'dev' ? devVersion : betaVersion;
  if (
    !kind.test(plan.version) ||
    (plan.previous &&
      ((!kind.test(plan.previous.version) && !stableVersion.test(plan.previous.version)) ||
        (kind.test(plan.previous.version) &&
          compareVersions(plan.previous.version, plan.version) >= 0)))
  )
    throw new Error(`Invalid ${channel} release plan`);
  for (const target of [plan, ...(plan.previous ? [plan.previous] : [])]) {
    const published = history.versions[target.version];
    if (!published || releaseCommit(published) !== target.commit)
      throw new Error(`npm has not published ${target.version} from the expected source commit`);
    if (target.commit !== plan.commit && !isAncestor(target.commit, plan.commit))
      throw new Error('Prerelease baseline is not an ancestor of source');
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
      throw new Error('Existing Release does not match a published prerelease');
    return release.html_url;
  }

  const tagged = checkTag(tag, plan.commit);
  if (channel === 'beta' && !tagged) throw new Error('Beta release tag is missing');
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
  const body = compatibility ? releaseCompatibilityNotes(notes.body, compatibility) : notes.body;
  ensureTag(tag, plan.commit);
  try {
    const release = releaseSchema.parse(
      api('POST', `${root}/releases`, {
        tag_name: tag,
        target_commitish: plan.commit,
        name: tag,
        body: contract ? releaseDatabaseNotes(body, contract) : body,
        draft: false,
        prerelease: true,
        make_latest: 'false',
      }),
    );
    if (release.tag_name !== tag || !release.prerelease || release.draft)
      throw new Error('GitHub did not create the expected prerelease');
    return release.html_url;
  } catch (error) {
    const created = existingRelease();
    if (created) return created;
    throw error;
  }
}

export function githubApi(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) {
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
