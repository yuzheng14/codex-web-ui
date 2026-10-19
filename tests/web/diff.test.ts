import { describe, expect, it } from 'vitest';
import { parseDiff } from '../../src/web/lib/diff';

describe('saved unified patches', () => {
  it('tracks old and new line numbers across changes and multiple hunks', () => {
    const [file] = parseDiff(
      '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -8,3 +8,4 @@ fn\n context\n-old\n+new\n+extra\n tail\n@@ -40 +41 @@\n-last\n+next\n',
    );
    expect(file).toMatchObject({
      path: 'src/a.ts',
      kind: 'modified',
      additions: 3,
      deletions: 2,
      incomplete: false,
    });
    expect(file!.hunks[0]!.lines).toEqual([
      { kind: 'context', text: 'context', oldLine: 8, newLine: 8 },
      { kind: 'removed', text: 'old', oldLine: 9 },
      { kind: 'added', text: 'new', newLine: 9 },
      { kind: 'added', text: 'extra', newLine: 10 },
      { kind: 'context', text: 'tail', oldLine: 10, newLine: 11 },
    ]);
    expect(file!.hunks[1]!.lines[1]).toMatchObject({ text: 'next', newLine: 41 });
  });
  it('separates files and recognizes add, delete, rename, binary and mode-only changes', () => {
    const files = parseDiff(
      [
        'diff --git a/new b/new',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new',
        '@@ -0,0 +1 @@',
        '+added',
        'diff --git a/old b/old',
        'deleted file mode 100644',
        '--- a/old',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-gone',
        'diff --git a/from b/to',
        'similarity index 100%',
        'rename from from',
        'rename to to',
        'diff --git a/image.png b/image.png',
        'Binary files a/image.png and b/image.png differ',
        'diff --git a/run.sh b/run.sh',
        'old mode 100644',
        'new mode 100755',
      ].join('\n'),
    );
    expect(files.map((file) => file.kind)).toEqual([
      'added',
      'deleted',
      'renamed',
      'modified',
      'modified',
    ]);
    expect(files[2]).toMatchObject({ oldPath: 'from', path: 'to', hunks: [] });
    expect(files[3]).toMatchObject({ binary: true, hunks: [] });
    expect(files[4]!.metadata).toContain('new mode 100755');
  });
  it('handles headers without diff --git, omitted counts and source that resembles headers', () => {
    const files = parseDiff(
      '--- a/one\n+++ b/one\n@@ -1 +1 @@\n--- source\n+++ source\n--- a/two\n+++ b/two\n@@ -0,0 +1 @@\n+second\n',
    );
    expect(files).toHaveLength(2);
    expect(files[0]!.hunks[0]!.lines.map((line) => line.text)).toEqual(['-- source', '++ source']);
    expect(files[1]!.path).toBe('two');
  });
  it('decodes quoted Git UTF-8 octal paths and preserves spaces', () => {
    const [file] = parseDiff(
      'diff --git "a/\\344\\270\\255 space.md" "b/\\344\\270\\255 space.md"\n--- "a/\\344\\270\\255 space.md"\n+++ "b/\\344\\270\\255 space.md"\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(file!.path).toBe('中 space.md');
    expect(parseDiff('--- a/a file.md\n+++ b/a file.md\n')[0]!.path).toBe('a file.md');
  });
  it('removes ANSI colors and OSC hyperlinks and accepts CRLF patches', () => {
    const patch =
      '\x1b[31m--- a/a\x1b[0m\r\n+++ b/a\r\n@@ -1 +1 @@\r\n-a\r\n+\x1b]8;;https://example.com\x07b\x1b]8;;\x07\r\n';
    expect(parseDiff(patch)[0]!.hunks[0]!.lines[1]!.text).toBe('b');
    expect(JSON.stringify(parseDiff(patch))).not.toContain('\\u001b');
  });
  it('retains missing-newline notes, blank context and empty added lines', () => {
    const [file] = parseDiff(
      '@@ -1,2 +1,2 @@\n \n-a\n\\ No newline at end of file\n+\n\\ No newline at end of file\n',
      { path: 'a', kind: 'update' },
    );
    expect(file!.hunks[0]!.lines.map((line) => line.kind)).toEqual([
      'context',
      'removed',
      'note',
      'added',
      'note',
    ]);
    expect(file!.incomplete).toBe(false);
  });
  it('uses tool metadata for headerless additions and reports incomplete hunks', () => {
    const [file] = parseDiff('@@ -0,0 +1,3 @@\n+only first line\n', {
      path: '/project/new.ts',
      kind: 'add',
    });
    expect(file).toMatchObject({
      path: '/project/new.ts',
      kind: 'added',
      additions: 1,
      incomplete: true,
    });
    expect(parseDiff('@@ invalid\n+text')[0]!.incomplete).toBe(true);
  });
  it('represents empty patches and unsupported input without inventing code lines', () => {
    expect(parseDiff(' \n')).toEqual([]);
    expect(parseDiff('', { path: 'empty.ts', kind: 'add' })[0]).toMatchObject({
      path: 'empty.ts',
      kind: 'added',
      hunks: [],
    });
    expect(parseDiff('read failed')[0]).toMatchObject({ hunks: [], metadata: ['read failed'] });
  });
  it('does not render binary patch payload as metadata or code', () => {
    expect(
      parseDiff('diff --git a/a b/a\nGIT binary patch\nliteral 4\n!secret-payload\n')[0],
    ).toMatchObject({ binary: true, metadata: [], hunks: [] });
  });
});
