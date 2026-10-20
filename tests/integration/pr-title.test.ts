import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { checkPullRequestTitle, validatePrTitle } from '../../scripts/check-pr-title.js';

const sha = '1'.repeat(40);

it.each([
  'feat',
  'fix',
  'deps',
  'perf',
  'build',
  'revert',
  'docs',
  'refactor',
  'test',
  'ci',
  'chore',
])('accepts the supported %s type with optional scope and breaking marker', (type) => {
  for (const suffix of ['', '(ui)', '!', '(api)!'])
    expect(() => validatePrTitle(`${type}${suffix}: describe the change`)).not.toThrow();
});

it.each([
  ['add a feature', 'type'],
  [': add a feature', 'type'],
  ['unknown: add a feature', 'Unknown'],
  ['Feat: add a feature', 'type'],
  ['fix:', 'space'],
  ['fix: ', 'description'],
  ['fix:   ', 'description'],
  ['fix(): describe the change', 'scope'],
  ['fix( ): describe the change', 'scope'],
  ['fix((ui)): describe the change', 'type'],
  ['fix: first line\nsecond line', 'single line'],
  ['fix: first line\rsecond line', 'single line'],
  ['fix: first line\u2028second line', 'single line'],
  ['', 'missing'],
  [undefined, 'missing'],
])('rejects invalid title %j with a specific reason', (title, reason) => {
  expect(() => validatePrTitle(title)).toThrow(reason);
});

it('accepts Chinese descriptions and release-please titles without a bot exemption', () => {
  validatePrTitle('feat(ui): 增加 JSON 预览');
  validatePrTitle('chore(main): release 0.2.0');
  validatePrTitle('chore: release main');
});

it('reads the latest title and recovers after an edit without a new commit', () => {
  const pr = { title: 'missing type', head: { sha } };
  const read = vi.fn(() => pr);
  expect(() => checkPullRequestTitle('yuzheng14/covro', '175', sha, read)).toThrow('type');
  pr.title = 'fix: preserve scroll position';
  checkPullRequestTitle('yuzheng14/covro', '175', sha, read);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith('repos/yuzheng14/covro/pulls/175');
});

it.each([
  ['same repository', 'yuzheng14/covro', 'main', 'feat(ui): add JSON preview', 'User'],
  ['fork', 'contributor/covro', 'main', 'fix: preserve scroll position', 'User'],
  ['stack', 'yuzheng14/covro', 'feature/base', 'test: cover the next layer', 'User'],
  ['release bot', 'yuzheng14/covro', 'main', 'chore(main): release 0.2.0', 'Bot'],
])('checks %s PRs with the same rules', (_source, repository, base, title, userType) => {
  const pr = {
    title,
    head: { sha, repo: { full_name: repository } },
    base: { ref: base },
    user: { type: userType },
  };
  checkPullRequestTitle('yuzheng14/covro', '175', sha, () => pr);
  expect(() =>
    checkPullRequestTitle('yuzheng14/covro', '175', sha, () => ({
      ...pr,
      title: 'missing type',
    })),
  ).toThrow('type');
});

it('fails closed for missing PR identity and malformed API responses', () => {
  const read = vi.fn(() => ({ title: 'fix: valid', head: { sha } }));
  for (const number of [undefined, '', '0', '../175', '175; echo injected'])
    expect(() => checkPullRequestTitle('yuzheng14/covro', number, sha, read)).toThrow('required');
  expect(() => checkPullRequestTitle('../covro/other', '175', sha, read)).toThrow('required');
  expect(() => checkPullRequestTitle('yuzheng14/covro', '175', undefined, read)).toThrow(
    'required',
  );
  expect(read).not.toHaveBeenCalled();
  for (const response of [null, {}, { title: 123 }])
    expect(() => checkPullRequestTitle('yuzheng14/covro', '175', sha, () => response)).toThrow();
});

it('rejects a dispatch that tries to use another PR or an outdated head to satisfy the check', () => {
  const read = () => ({ title: 'fix: valid', head: { sha: '2'.repeat(40) } });
  expect(() => checkPullRequestTitle('yuzheng14/covro', '175', sha, read)).toThrow('head SHA');
});

it('runs in native Node without dependencies and prints actionable CI errors with a failing exit code', () => {
  const directory = mkdtempSync(join(tmpdir(), 'covro-pr-title-'));
  try {
    const titleFile = join(directory, 'pr.json');
    writeFileSync(
      join(directory, 'gh'),
      '#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(process.env.PR_FIXTURE));\n',
      { mode: 0o700 },
    );
    const run = () =>
      spawnSync(process.execPath, ['scripts/check-pr-title.ts'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_REPOSITORY: 'yuzheng14/covro',
          PR_NUMBER: '175',
          PR_HEAD_SHA: sha,
          PR_FIXTURE: titleFile,
        },
      });
    writeFileSync(titleFile, JSON.stringify({ title: 'fix: ', head: { sha } }));
    const invalid = run();
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('::error title=Invalid PR title::');
    expect(invalid.stderr).toContain('description is missing');
    expect(invalid.stderr).toContain('feat(ui): add JSON preview');
    expect(invalid.stderr).toContain('no new commit is needed');
    writeFileSync(
      titleFile,
      JSON.stringify({ title: 'chore(main): release 0.2.0', head: { sha } }),
    );
    expect(run()).toMatchObject({ status: 0, stderr: '' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
