import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { betaTarget, dispatchBetaRelease } from '../../scripts/dispatch-beta-release.js';
import { planRelease } from '../../scripts/prepare-release.js';

const repository = 'yuzheng14/covro';
const commit = '1'.repeat(40);
const annotation = '2'.repeat(40);
const tag = 'v0.1.0-beta.1';
const repo = { full_name: repository };
const push = {
  repository: repo,
  ref: `refs/tags/${tag}`,
  after: commit,
  created: true,
  deleted: false,
  forced: false,
};
const release = {
  repository: repo,
  action: 'published',
  release: { tag_name: tag, draft: false, prerelease: true },
};
const cleanups: string[] = [];
afterEach(() => {
  for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function github(objects: Record<string, unknown> = {}) {
  return vi.fn((args: string[]) => {
    if (args[0] === 'workflow') return '';
    if (args[0] !== 'api') throw new Error('Unexpected GitHub command');
    const response =
      objects[args[1]!] ??
      (args[1] === `repos/${repository}/git/ref/tags/${tag}`
        ? { object: { type: 'commit', sha: commit } }
        : undefined);
    if (!response) throw new Error(`Unexpected API call ${args[1]}`);
    return JSON.stringify(response);
  });
}

it('derives Beta versions from new tag pushes and published Releases, including draft-to-published transitions', () => {
  expect(betaTarget('push', push)).toEqual({ tag, version: '0.1.0-beta.1', after: commit });
  expect(betaTarget('release', release)).toEqual({ tag, version: '0.1.0-beta.1' });
  // The immutable Beta tag decides the npm channel, even if the author did not tick prerelease.
  expect(
    betaTarget('release', { ...release, release: { ...release.release, prerelease: false } }),
  ).toEqual({ tag, version: '0.1.0-beta.1' });
});

it('ignores normal main pushes, stable releases, drafts, edits and tag deletions', () => {
  expect(betaTarget('push', { ...push, ref: 'refs/heads/main' })).toBeUndefined();
  expect(betaTarget('push', { ...push, ref: 'refs/tags/v0.1.0' })).toBeUndefined();
  expect(
    betaTarget('release', { ...release, release: { ...release.release, tag_name: 'v0.1.0' } }),
  ).toBeUndefined();
  expect(
    betaTarget('release', { ...release, release: { ...release.release, draft: true } }),
  ).toBeUndefined();
  expect(betaTarget('release', { ...release, action: 'edited' })).toBeUndefined();
  expect(betaTarget('push', { ...push, deleted: true })).toBeUndefined();
  expect(betaTarget('workflow_run', {})).toBeUndefined();
});

it('rejects malformed Beta names and moved tags before dispatching anything', () => {
  for (const value of [
    'v01.1.0-beta.1',
    'v0.1.0-beta.01',
    'v0.1.0-beta.1+build',
    'v0.1.0-beta.1;echo injected',
  ])
    expect(() => betaTarget('push', { ...push, ref: `refs/tags/${value}` })).toThrow('Beta tags');
  expect(() => betaTarget('push', { ...push, created: false })).toThrow('cannot be moved');
  expect(() => betaTarget('push', { ...push, forced: true })).toThrow('cannot be moved');
});

it('dispatches the existing main publisher with an exact commit, independent of mutable release target_commitish', () => {
  const run = github();
  expect(
    dispatchBetaRelease(
      'release',
      { ...release, release: { ...release.release, target_commitish: 'unrelated-branch' } },
      repository,
      run,
    ),
  ).toEqual({ tag, version: '0.1.0-beta.1', commit });
  expect(run).toHaveBeenLastCalledWith([
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
    'version=0.1.0-beta.1',
    '-f',
    `source_ref=${commit}`,
  ]);
});

it('peels annotated tags and accepts either GitHub push SHA representation', () => {
  for (const after of [annotation, commit]) {
    const run = github({
      [`repos/${repository}/git/ref/tags/${tag}`]: { object: { type: 'tag', sha: annotation } },
      [`repos/${repository}/git/tags/${annotation}`]: { object: { type: 'commit', sha: commit } },
    });
    expect(dispatchBetaRelease('push', { ...push, after }, repository, run)?.commit).toBe(commit);
    expect(run).toHaveBeenCalledWith(['api', `repos/${repository}/git/tags/${annotation}`]);
  }
});

it('rejects stale pushes, cross-repository events and tags that do not resolve to a commit', () => {
  expect(() =>
    dispatchBetaRelease('push', { ...push, after: '3'.repeat(40) }, repository, github()),
  ).toThrow('moved after');
  expect(() =>
    dispatchBetaRelease(
      'push',
      { ...push, repository: { full_name: 'other/repo' } },
      repository,
      github(),
    ),
  ).toThrow('repository');
  const run = github({
    [`repos/${repository}/git/ref/tags/${tag}`]: { object: { type: 'tree', sha: commit } },
  });
  expect(() => dispatchBetaRelease('push', push, repository, run)).toThrow(
    'does not point to a commit',
  );
  expect(run.mock.calls.some(([args]) => args[0] === 'workflow')).toBe(false);
});

it('refuses invalid or cyclic annotated tag API responses', () => {
  const run = github({
    [`repos/${repository}/git/ref/tags/${tag}`]: { object: { type: 'tag', sha: annotation } },
    [`repos/${repository}/git/tags/${annotation}`]: { object: { type: 'tag', sha: annotation } },
  });
  expect(() => dispatchBetaRelease('release', release, repository, run)).toThrow('tag chain');
  expect(() =>
    dispatchBetaRelease(
      'release',
      release,
      repository,
      github({
        [`repos/${repository}/git/ref/tags/${tag}`]: {
          object: { type: 'commit', sha: '--bad-ref' },
        },
      }),
    ),
  ).toThrow('identity');
});

it('routes tag plus Release to the same immutable version, which the publisher skips on repetition', () => {
  const run = github();
  const first = dispatchBetaRelease('push', push, repository, run)!;
  const second = dispatchBetaRelease('release', release, repository, run)!;
  expect(first).toEqual(second);
  expect(
    planRelease(
      {
        channel: 'beta',
        current: '0.1.0',
        commit,
        mainCommit: commit,
        requested: second.version,
        firstRelease: true,
      },
      {
        name: '@covro/covro',
        versions: {
          [first.version]: {
            name: '@covro/covro',
            version: first.version,
            covroCommit: first.commit,
          },
        },
        'dist-tags': { beta: first.version },
      },
      () => false,
    ),
  ).toMatchObject({ skip: true, version: first.version });
});

it('runs the event dispatcher using native Node without installing project dependencies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'covro-beta-trigger-'));
  cleanups.push(directory);
  const event = join(directory, 'event.json');
  const capture = join(directory, 'command.json');
  writeFileSync(event, JSON.stringify(push));
  writeFileSync(
    join(directory, 'gh'),
    `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2); if(args[0]==='api') console.log(JSON.stringify({object:{type:'commit',sha:${JSON.stringify(commit)}}})); else fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(args));\n`,
    { mode: 0o700 },
  );
  const output = execFileSync(process.execPath, ['scripts/dispatch-beta-release.ts'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      PATH: `${directory}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: repository,
      GH_TOKEN: 'fixture',
    },
  });
  expect(output).toContain(`Dispatched Beta 0.1.0-beta.1 from ${tag}`);
  expect(JSON.parse(readFileSync(capture, 'utf8'))).toContain(`source_ref=${commit}`);
});
