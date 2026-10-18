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
function main() {
  const tag = process.env.RELEASE_TAG ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Invalid stable release identity');
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
  };
  if (`v${metadata.version}` !== tag)
    throw new Error('Release package version does not match its tag');
  const release = JSON.parse(
    execFileSync('gh', ['release', 'view', tag, '--repo', repository, '--json', 'body'], {
      encoding: 'utf8',
    }),
  ) as { body: string };
  const directory = mkdtempSync(join(tmpdir(), 'covro-release-notes-'));
  try {
    const notes = join(directory, 'notes.md');
    writeFileSync(notes, releaseCompatibilityNotes(release.body, metadata.covroCodex));
    execFileSync('gh', ['release', 'edit', tag, '--repo', repository, '--notes-file', notes], {
      stdio: 'inherit',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
