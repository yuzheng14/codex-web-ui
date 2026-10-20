import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const types = [
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
];
const help = [
  'Use <type>[optional scope][!]: <description>. Scope is optional; types must be lowercase.',
  `Allowed types: ${types.join(', ')}.`,
  'Examples: feat(ui): add JSON preview; fix: preserve scroll position; feat(api)!: change the response format.',
  'Edit the PR title to rerun this check; no new commit is needed.',
].join('\n');

export function validatePrTitle(title: unknown): void {
  if (typeof title !== 'string' || !title.trim()) throw new Error('The PR title is missing.');
  if (/[\r\n\u2028\u2029]/.test(title)) throw new Error('The PR title must be a single line.');
  const header = /^([a-z]+)(?:\(([^()]*)\))?(!)?: (.*)$/.exec(title);
  if (!header)
    throw new Error(
      'The PR title must have a type, optional scope/!, and a colon followed by a space.',
    );
  if (!types.includes(header[1]!)) throw new Error(`Unknown PR title type: ${header[1]}.`);
  if (header[2] !== undefined && !header[2].trim())
    throw new Error('An included scope cannot be empty.');
  if (!header[4]!.trim()) throw new Error('The PR title description is missing.');
}

export function checkPullRequestTitle(
  repository: string,
  number: string | undefined,
  headSha: string | undefined,
  readPullRequest: (path: string) => unknown = (path) =>
    JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' })),
): void {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !number ||
    !/^[1-9]\d*$/.test(number) ||
    !headSha ||
    !/^[0-9a-f]{40}$/.test(headSha)
  )
    throw new Error('A repository, PR number, and head SHA are required.');
  // Read the current title rather than a possibly stale opened/synchronize event payload.
  const pr = readPullRequest(`repos/${repository}/pulls/${number}`);
  if (!pr || typeof pr !== 'object' || !('title' in pr))
    throw new Error('GitHub returned no PR title.');
  if (
    !('head' in pr) ||
    !pr.head ||
    typeof pr.head !== 'object' ||
    !('sha' in pr.head) ||
    pr.head.sha !== headSha
  )
    throw new Error(
      'The PR head SHA does not match this workflow. Dispatch on the current PR head branch.',
    );
  validatePrTitle(pr.title);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkPullRequestTitle(
      process.env.GITHUB_REPOSITORY ?? '',
      process.env.PR_NUMBER,
      process.env.PR_HEAD_SHA,
    );
    console.log('The current PR title follows Conventional Commits.');
  } catch (error) {
    const message = `${error instanceof Error ? error.message : String(error)}\n${help}`;
    // Escape workflow-command data so even API errors cannot create extra annotations.
    const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.error(`::error title=Invalid PR title::${escaped}`);
    process.exitCode = 1;
  }
}
