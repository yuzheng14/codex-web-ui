import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { npmPackageName } from '../../src/shared/package.js';
import {
  planDevGitHubRelease,
  publishDevGitHubRelease,
  type DevReleasePlan,
  type GitHubApi,
} from '../../scripts/dev-github-release.js';
import type { PackageRegistry } from '../../scripts/release-registry.js';

const old = '1'.repeat(40);
const stable = '2'.repeat(40);
const source = '3'.repeat(40);
const future = '4'.repeat(40);
const ancestor = (a: string, b: string) => a <= b;
const version = '0.2.1-dev.2';
const target = { version, commit: source, skip: false };
function registry(entries: [string, string][]): PackageRegistry {
  return {
    name: npmPackageName,
    versions: Object.fromEntries(
      entries.map(([version, commit]) => [
        version,
        {
          name: npmPackageName,
          version,
          covroCommit: commit,
        },
      ]),
    ),
    'dist-tags': {}, // Selection must survive moved/deleted tags, including the current dev tag.
  };
}

it('chooses the newer source, even when the older Dev has a larger SemVer than stable', () => {
  const history = registry([
    ['0.2.1-dev.1', old],
    ['0.2.0', stable],
    ['0.3.0-beta.1', source],
  ]);
  expect(planDevGitHubRelease(target, history, ancestor)?.previous).toEqual({
    version: '0.2.0',
    commit: stable,
  });
  history.versions['0.2.1-dev.1']!.covroCommit = source;
  expect(planDevGitHubRelease(target, history, ancestor)?.previous).toEqual({
    version: '0.2.1-dev.1',
    commit: source,
  });
  history.versions['0.2.0']!.covroCommit = source;
  expect(planDevGitHubRelease(target, history, ancestor)?.previous?.version).toBe('0.2.0');
});

it('handles the first Dev and stable-only history, including legacy multi-part Dev versions', () => {
  expect(planDevGitHubRelease(target, registry([]), ancestor)).toEqual({ version, commit: source });
  expect(
    planDevGitHubRelease(target, registry([['0.2.0', stable]]), ancestor)?.previous?.version,
  ).toBe('0.2.0');
  expect(
    planDevGitHubRelease(target, registry([['0.1.0-dev.39202054561.1', old]]), ancestor)?.previous
      ?.commit,
  ).toBe(old);
  expect(
    planDevGitHubRelease(target, registry([['0.2.1-dev.1+build.1', old]]), ancestor)?.previous
      ?.version,
  ).toBe('0.2.1-dev.1+build.1');
});

it('repairs the original published snapshot on retries without using newer Dev/stable as its base', () => {
  const history = registry([
    ['0.1.0', old],
    ['0.2.0', stable],
    ['0.2.1-dev.1', stable],
    [version, source],
    ['0.2.1-dev.3', future],
    ['0.3.0', future],
  ]);
  expect(
    planDevGitHubRelease({ ...target, version: '0.2.1-dev.3', skip: true }, history, ancestor),
  ).toEqual({
    version,
    commit: source,
    previous: { version: '0.2.0', commit: stable },
  });
  expect(
    planDevGitHubRelease({ ...target, commit: '5'.repeat(40), skip: true }, history, ancestor),
  ).toBeUndefined();
});

it('rejects unknown or divergent baseline identities and invalid release versions', () => {
  const history = registry([['0.2.0', stable]]);
  delete history.versions['0.2.0']!.covroCommit;
  expect(() => planDevGitHubRelease(target, history, ancestor)).toThrow('no source commit');
  expect(() => planDevGitHubRelease(target, registry([['0.2.0', stable]]), () => false)).toThrow(
    'diverges',
  );
  expect(() =>
    planDevGitHubRelease({ ...target, version: '0.2.1-beta.1' }, registry([]), ancestor),
  ).toThrow('Invalid Dev version');
});

function githubFixture() {
  const refs = new Map<string, { type: string; sha: string }>();
  const annotations = new Map<string, { type: string; sha: string }>();
  const releases = new Map<string, Record<string, unknown>>();
  const notes =
    "## What's Changed\n* Add previews by @alice in https://github.com/example/covro/pull/1\n\n**Full Changelog**: comparison";
  let failCreate = false;
  let tagRace = false;
  const api = vi.fn<GitHubApi>((method, path, body) => {
    const root = 'repos/example/covro';
    if (method === 'GET' && path.startsWith(`${root}/git/ref/tags/`)) {
      const value = refs.get(path.slice(`${root}/git/ref/tags/`.length));
      return value ? { object: value } : undefined;
    }
    if (method === 'GET' && path.startsWith(`${root}/git/tags/`))
      return { object: annotations.get(path.slice(`${root}/git/tags/`.length)) };
    if (method === 'GET' && path.startsWith(`${root}/releases/tags/`))
      return releases.get(path.slice(`${root}/releases/tags/`.length));
    if (method === 'POST' && path === `${root}/git/refs`) {
      refs.set(String(body!.ref).replace('refs/tags/', ''), {
        type: 'commit',
        sha: String(body!.sha),
      });
      if (tagRace) throw new Error('Reference already exists');
      return {};
    }
    if (method === 'POST' && path === `${root}/releases/generate-notes`) return { body: notes };
    if (method === 'POST' && path === `${root}/releases`) {
      if (failCreate) throw new Error('Temporary GitHub failure');
      const release = {
        ...body,
        html_url: `https://github.com/example/covro/releases/tag/${body!.tag_name}`,
      };
      releases.set(String(body!.tag_name), release);
      return release;
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  const plan: DevReleasePlan = {
    version,
    commit: source,
    previous: { version: '0.2.0', commit: stable },
  };
  const history = registry([
    ['0.2.0', stable],
    [version, source],
  ]);
  const publish = () => publishDevGitHubRelease('example/covro', plan, history, ancestor, api);
  return {
    refs,
    annotations,
    releases,
    notes,
    api,
    plan,
    history,
    publish,
    failCreate: (value: boolean) => {
      failCreate = value;
    },
    raceTag: () => {
      tagRace = true;
    },
  };
}

it('creates exact tags and a non-latest prerelease using the generated body and explicit baseline', () => {
  const h = githubFixture();
  expect(h.publish()).toBe(`https://github.com/example/covro/releases/tag/v${version}`);
  expect(h.refs.get('v0.2.0')?.sha).toBe(stable);
  expect(h.refs.get(`v${version}`)?.sha).toBe(source);
  expect(h.api).toHaveBeenCalledWith('POST', 'repos/example/covro/releases/generate-notes', {
    tag_name: `v${version}`,
    target_commitish: source,
    previous_tag_name: 'v0.2.0',
  });
  expect(h.releases.get(`v${version}`)).toMatchObject({
    name: `v${version}`,
    body: h.notes,
    prerelease: true,
    draft: false,
    make_latest: 'false',
  });
  h.api.mockClear();
  h.publish();
  expect(h.api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
});

it('backfills a preceding npm Dev tag when rollout predates GitHub Dev releases', () => {
  const h = githubFixture();
  h.plan.previous = { version: '0.2.1-dev.1', commit: stable };
  h.history = registry([
    ['0.2.1-dev.1', stable],
    [version, source],
  ]);
  publishDevGitHubRelease('example/covro', h.plan, h.history, ancestor, h.api);
  expect(h.refs.get('v0.2.1-dev.1')?.sha).toBe(stable);
  expect(h.api).toHaveBeenCalledWith(
    'POST',
    'repos/example/covro/releases/generate-notes',
    expect.objectContaining({ previous_tag_name: 'v0.2.1-dev.1' }),
  );
});

it('peels annotated tags and rejects source conflicts before creating a Release', () => {
  const h = githubFixture();
  h.refs.set('v0.2.0', { type: 'tag', sha: old });
  h.annotations.set(old, { type: 'commit', sha: stable });
  h.publish();
  const wrong = githubFixture();
  wrong.refs.set(`v${version}`, { type: 'commit', sha: future });
  expect(wrong.publish).toThrow('different source commit');
  expect(wrong.api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  const badBase = githubFixture();
  badBase.refs.set('v0.2.0', { type: 'commit', sha: future });
  expect(badBase.publish).toThrow('different source commit');
  expect(badBase.releases.size).toBe(0);
});

it('never creates a GitHub artifact for an unpublished version, mismatched source or invalid baseline', () => {
  for (const mutation of ['missing', 'commit', 'baseline'] as const) {
    const h = githubFixture();
    if (mutation === 'missing') delete h.history.versions[version];
    if (mutation === 'commit') h.history.versions[version]!.covroCommit = future;
    if (mutation === 'baseline') {
      h.plan.previous!.commit = future;
      h.history.versions['0.2.0']!.covroCommit = future;
    }
    expect(h.publish).toThrow();
    expect(h.api).not.toHaveBeenCalled();
  }
});

it('repairs a failed Release creation using the immutable tags and tolerates an identical tag race', () => {
  const h = githubFixture();
  h.failCreate(true);
  expect(h.publish).toThrow('Temporary GitHub failure');
  expect(h.refs.get(`v${version}`)?.sha).toBe(source);
  h.failCreate(false);
  h.publish();
  expect(h.releases.size).toBe(1);
  const raced = githubFixture();
  raced.raceTag();
  expect(raced.publish).not.toThrow();
});

it('uses the initial notes range without history and refuses to overwrite an existing draft/full release', () => {
  const h = githubFixture();
  delete h.plan.previous;
  h.publish();
  expect(h.api).toHaveBeenCalledWith('POST', 'repos/example/covro/releases/generate-notes', {
    tag_name: `v${version}`,
    target_commitish: source,
  });
  for (const flags of [
    { prerelease: false, draft: false },
    { prerelease: true, draft: true },
  ]) {
    const bad = githubFixture();
    bad.refs.set(`v${version}`, { type: 'commit', sha: source });
    bad.releases.set(`v${version}`, {
      tag_name: `v${version}`,
      html_url: 'https://github.com/example/covro/releases/tag/test',
      ...flags,
    });
    expect(bad.publish).toThrow('published prerelease');
    expect(bad.api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  }
});

it('runs the real CLI with npm/gh fixtures, handles 404, and sends native notes as JSON without shell evaluation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'covro-dev-github-cli-'));
  try {
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Covro fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        },
      ).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(directory, 'source.txt'), 'base');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'source.txt'), 'new Dev');
    git('commit', '-qam', 'Dev');
    const commit = git('rev-parse', 'HEAD');
    const history = registry([
      ['0.2.0', base],
      [version, commit],
    ]);
    const nativeNotes =
      "## What's Changed\n* Fix `$(touch should-not-exist)` by @alice\n\n**Full Changelog**: exact range";
    writeFileSync(join(directory, 'registry.json'), JSON.stringify(history));
    writeFileSync(
      join(directory, 'fetch.mjs'),
      `import { readFileSync } from 'node:fs';
globalThis.fetch = async () => new Response(readFileSync(process.env.FIXTURE_DIRECTORY + '/registry.json', 'utf8'));\n`,
    );
    writeFileSync(
      join(directory, 'state.json'),
      JSON.stringify({ refs: {}, releases: {}, calls: [] }),
    );
    writeFileSync(
      join(directory, 'gh'),
      `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const filename=process.env.FIXTURE_DIRECTORY+'/state.json';
const state=JSON.parse(readFileSync(filename,'utf8'));
const args=process.argv.slice(2);
const method=args[args.indexOf('--method')+1];
const path=args[args.indexOf('--method')+2];
const body=args.includes('--input')?JSON.parse(readFileSync(0,'utf8')):undefined;
state.calls.push({method,path,body});
let result;
if(method==='GET'&&path.includes('/git/ref/tags/')) {
 const ref=state.refs[path.split('/git/ref/tags/')[1]];
 if(ref)result={object:{type:'commit',sha:ref}};
} else if(method==='GET'&&path.includes('/releases/tags/'))result=state.releases[path.split('/releases/tags/')[1]];
else if(method==='POST'&&path.endsWith('/git/refs')) {state.refs[body.ref.replace('refs/tags/','')]=body.sha;result={};}
else if(method==='POST'&&path.endsWith('/generate-notes'))result={body:process.env.FIXTURE_NOTES};
else if(method==='POST'&&path.endsWith('/releases')) {
 result={...body,html_url:'https://github.com/example/covro/releases/tag/'+body.tag_name};
 state.releases[body.tag_name]=result;
} else throw new Error('Unexpected gh request');
writeFileSync(filename,JSON.stringify(state));
if(result===undefined){process.stderr.write('gh: Not Found (HTTP 404)');process.exit(1);}
console.log(JSON.stringify(result));
`,
      { mode: 0o700 },
    );
    const run = () =>
      execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--import',
          join(directory, 'fetch.mjs'),
          resolve('scripts/dev-github-release.ts'),
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GH_TOKEN: 'fixture',
            GITHUB_REPOSITORY: 'example/covro',
            FIXTURE_DIRECTORY: directory,
            FIXTURE_NOTES: nativeNotes,
            DEV_RELEASE_VERSION: version,
            DEV_BASE_VERSION: '0.2.0',
            DEV_BASE_COMMIT: base,
          },
        },
      );
    expect(run()).toContain(`/releases/tag/v${version}`);
    const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
    expect(state.refs[`v${version}`]).toBe(commit);
    expect(state.releases[`v${version}`]).toMatchObject({
      body: nativeNotes,
      prerelease: true,
      make_latest: 'false',
    });
    const count = state.calls.length;
    run();
    const repeated = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
    expect(
      repeated.calls.slice(count).every((call: { method: string }) => call.method === 'GET'),
    ).toBe(true);
    writeFileSync(join(directory, 'registry.json'), JSON.stringify(registry([])));
    expect(run).toThrow('npm has not published');
    expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).calls).toHaveLength(
      repeated.calls.length,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
