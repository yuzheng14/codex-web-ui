import { databaseCompatibilityMarkdown } from '../src/shared/database.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compatibilityMarkdown } from './sync-compatibility.js';

export function releaseCompatibilityNotes(body: string, metadata: unknown) {
  const existing = /\n*<!-- covro-codex:start -->[\s\S]*?<!-- covro-codex:end -->/g;
  return `${body.replace(existing, '').trim()}\n\n<!-- covro-codex:start -->\n### Codex CLI compatibility\n\n${compatibilityMarkdown(metadata)}\n<!-- covro-codex:end -->\n`;
}

// GitHub builds its native Contributors avatar list from @mentions in the Release body.
// Keep release-please's grouping and links; only credit the author of each linked commit.
export function releaseAuthorNotes(
  body: string,
  repository: string,
  authorForCommit: (sha: string) => string | null,
) {
  if (
    !/^[a-z\d][a-z\d-]*\/[\w.-]+$/i.test(repository) ||
    ['.', '..'].includes(repository.split('/')[1] ?? '')
  )
    throw new Error('Invalid repository');
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const commitLink = new RegExp(
    `\\]\\(https://github\\.com/${escapedRepository}/commit/([a-f0-9]{7,40})\\)`,
    'i',
  );
  const authors = new Map<string, string | null>();
  let fence: string | undefined;
  return body
    .split('\n')
    .map((line) => {
      const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (delimiter) {
        if (!fence) fence = delimiter;
        else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
        return line;
      }
      if (fence || !/^[*-] /.test(line)) return line;
      const sha = commitLink.exec(line)?.[1]?.toLowerCase();
      if (!sha) return line;
      if (!authors.has(sha)) authors.set(sha, authorForCommit(sha));
      const author = authors.get(sha);
      if (author === null) return line; // An unlinked Git author has no GitHub account to mention.
      if (!author || !/^[a-z\d][a-z\d-]*(?:\[bot\])?$/i.test(author))
        throw new Error(`Invalid GitHub author for ${sha}`);
      const suffix = ` by @${author}`;
      const content = line.trimEnd();
      return content.endsWith(suffix) ? line : `${content}${suffix}${line.slice(content.length)}`;
    })
    .join('\n');
}

export function releaseDatabaseNotes(body: string, metadata: unknown) {
  const existing = /\n*<!-- covro-database:start -->[\s\S]*?<!-- covro-database:end -->/g;
  return `${body.replace(existing, '').trim()}\n\n<!-- covro-database:start -->\n### Database compatibility\n\n${databaseCompatibilityMarkdown(metadata)}\n<!-- covro-database:end -->\n`;
}

export function requireReleaseTag(tag: string, packageVersion?: string) {
  if (!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag)) throw new Error('Invalid release tag');
  if (!tag.includes('-beta.') && packageVersion !== undefined && `v${packageVersion}` !== tag)
    throw new Error('Release package version does not match its tag');
}

function main() {
  const tag = process.env.RELEASE_TAG ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  requireReleaseTag(tag);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid release repository');
  // Read the immutable tag, even when main has advanced since the Release was created.
  const file = JSON.parse(
    execFileSync(
      'gh',
      ['api', `repos/${repository}/contents/package.json?ref=${encodeURIComponent(tag)}`],
      { encoding: 'utf8' },
    ),
  ) as { content: string };
  const metadata = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as {
    version: string;
    covroCodex?: unknown;
    covroDatabase?: unknown;
  };
  // Beta tags retain the source package version; publication stamps the npm version separately.
  requireReleaseTag(tag, metadata.version);
  const release = JSON.parse(
    execFileSync('gh', ['release', 'view', tag, '--repo', repository, '--json', 'body'], {
      encoding: 'utf8',
    }),
  ) as { body: string };
  const body = releaseAuthorNotes(release.body, repository, (sha) => {
    const commit = JSON.parse(
      execFileSync('gh', ['api', `repos/${repository}/commits/${sha}`], { encoding: 'utf8' }),
    ) as { author: { login: string } | null };
    if (commit.author === null)
      console.warn(`Commit ${sha} has no linked GitHub author; leaving its entry unchanged.`);
    return commit.author?.login ?? null;
  });
  const directory = mkdtempSync(join(tmpdir(), 'covro-release-notes-'));
  try {
    const notes = join(directory, 'notes.md');
    writeFileSync(
      notes,
      releaseDatabaseNotes(
        releaseCompatibilityNotes(body, metadata.covroCodex),
        metadata.covroDatabase,
      ),
    );
    execFileSync('gh', ['release', 'edit', tag, '--repo', repository, '--notes-file', notes], {
      stdio: 'inherit',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
