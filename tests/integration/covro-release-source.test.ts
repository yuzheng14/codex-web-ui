import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
// Execute the actual workflow gate against real Git refs, including annotated tags.
const workflow = readFileSync(
  new URL('../../.github/workflows/publish.yml', import.meta.url),
  'utf8',
);
const source = /node --input-type=module <<'JS'\n([\s\S]*?)\n\s*JS/
  .exec(workflow)![1]!
  .replace(/^ {10}/gm, '');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'covro-release-source-'));
  directories.push(directory);
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
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
      { cwd: directory, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(directory, 'scripts'));
  writeFileSync(join(directory, 'scripts/verify-published-release.ts'), '// fixture\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    "#!/usr/bin/env node\nconsole.log(JSON.stringify([{check_runs:[{name:'verify',conclusion:process.env.COVRO_FIXTURE_CHECK||'success',app:{slug:'github-actions'}}]}]));\n",
    { mode: 0o700 },
  );
  const guard = (settings: Record<string, string> = {}) =>
    execFileSync(process.execPath, ['--input-type=module'], {
      cwd: directory,
      input: source,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'yuzheng14/covro',
        GH_TOKEN: 'fixture',
        RELEASE_CHANNEL: 'beta',
        RELEASE_VERSION: '0.1.0-beta.1',
        ...settings,
      },
    });
  return { directory, git, guard, sha };
}

it('accepts verified main source with a matching lightweight or annotated Beta tag', () => {
  for (const annotated of [false, true]) {
    const { git, guard } = fixture();
    git('tag', ...(annotated ? ['-a', '-m', 'Beta fixture'] : []), 'v0.1.0-beta.1');
    expect(guard()).toBe('');
  }
});

it('rejects a missing Beta tag or a source commit different from the exact version tag', () => {
  const { directory, git, guard } = fixture();
  expect(() => guard()).toThrow();
  git('tag', 'v0.1.0-beta.1');
  writeFileSync(join(directory, 'new.txt'), 'new source');
  git('add', '.');
  git('commit', '-qm', 'new source');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  expect(() => guard()).toThrow('Beta source must match its exact version tag');
});

it('rejects a Beta tag on a side branch even when that commit has successful checks', () => {
  const { directory, git, guard } = fixture();
  git('switch', '-qc', 'side');
  writeFileSync(join(directory, 'side.txt'), 'side source');
  git('add', '.');
  git('commit', '-qm', 'side source');
  git('tag', 'v0.1.0-beta.1');
  expect(() => guard()).toThrow('merge-base');
});

it('requires successful verify and rejects malformed Beta input without evaluating it', () => {
  const { git, guard } = fixture();
  git('tag', 'v0.1.0-beta.1');
  expect(() => guard({ COVRO_FIXTURE_CHECK: 'failure' })).toThrow('has not passed checks/verify');
  expect(() => guard({ RELEASE_VERSION: '0.1.0-beta.1;echo injected' })).toThrow(
    'Beta version must use',
  );
});

it('rejects source too old to run the publication verifier before any upload can occur', () => {
  const { directory, git, guard } = fixture();
  git('tag', 'v0.1.0-beta.1');
  rmSync(join(directory, 'scripts/verify-published-release.ts'));
  expect(() => guard()).toThrow('Source predates publication verification');
});

it('keeps Dev and stable source checks independent of the new Beta tag entry', () => {
  const { guard } = fixture();
  expect(guard({ RELEASE_CHANNEL: 'dev', RELEASE_VERSION: '' })).toBe('');
  expect(guard({ RELEASE_CHANNEL: 'stable', RELEASE_VERSION: '0.1.0' })).toBe('');
});
