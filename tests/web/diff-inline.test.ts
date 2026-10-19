import { describe, expect, it } from 'vitest';
import { highlightDiffHunks } from '../../src/web/lib/diff-inline';
import type { DiffHunk, DiffLine } from '../../src/web/lib/diff';

const line = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text });
function highlight(lines: DiffLine[]) {
  const hunk: DiffHunk = { header: '@@ -1 +1 @@', lines };
  const result = highlightDiffHunks([hunk])[0]!.lines;
  // Highlighting must preserve every source character and leave the parsed patch untouched.
  result.forEach((entry, index) =>
    expect(entry.segments?.map((part) => part.text).join('') ?? entry.text).toBe(
      lines[index]!.text,
    ),
  );
  expect(lines.every((entry) => !('segments' in entry))).toBe(true);
  return result.map(
    (entry) => entry.segments?.filter((part) => part.changed).map((part) => part.text) ?? [],
  );
}

describe('inline replacement highlights', () => {
  it('emphasizes the replaced word while keeping shared code on the row background', () => {
    expect(
      highlight([
        line('removed', '  const layout = "terminal";'),
        line('added', '  const layout = "web";'),
      ]),
    ).toEqual([['terminal'], ['web']]);
  });
  it('finds several separate edits without highlighting the unchanged middle', () => {
    expect(
      highlight([
        line('removed', 'const mode = "light"; const retries = 3;'),
        line('added', 'const mode = "dark"; const retries = 5;'),
      ]),
    ).toEqual([
      ['light', '3'],
      ['dark', '5'],
    ]);
  });
  it('keeps inserted lines unpaired and aligns the following related replacements', () => {
    expect(
      highlight([
        line('removed', 'const alpha = 1;'),
        line('removed', 'const beta = 2;'),
        line('added', '// a new explanatory note'),
        line('added', 'const alpha = 10;'),
        line('added', 'const beta = 20;'),
      ]),
    ).toEqual([[], [], [], ['0'], ['0']]);
  });
  it('leaves standalone additions, removals, unchanged and unrelated lines without inline marks', () => {
    expect(
      highlight([
        line('added', 'new file'),
        line('context', 'boundary'),
        line('removed', 'gone'),
        line('context', 'boundary'),
        line('removed', 'aaaa'),
        line('added', 'zzzz'),
      ]),
    ).toEqual([[], [], [], [], [], []]);
    expect(highlight([line('removed', 'same'), line('added', 'same')])).toEqual([[], []]);
  });
  it('handles whitespace-only changes and insertion or removal within a line', () => {
    expect(
      highlight([line('removed', '\treturn value;'), line('added', '  return value;')]),
    ).toEqual([['\t'], ['  ']]);
    expect(
      highlight([line('removed', 'const name = userName;'), line('added', 'const name = user;')]),
    ).toEqual([['Name'], []]);
  });
  it('keeps emoji and combining marks whole and supports non-Latin text', () => {
    expect(
      highlight([line('removed', 'const icon = "👩🏽‍💻";'), line('added', 'const icon = "👨🏻‍💻";')]),
    ).toEqual([['👩🏽‍💻'], ['👨🏻‍💻']]);
    expect(
      highlight([
        line('removed', 'const label = "e\u0301";'),
        line('added', 'const label = "e\u0300";'),
      ]),
    ).toEqual([['e\u0301'], ['e\u0300']]);
    expect(
      highlight([
        line('removed', 'const label = "旧版预览";'),
        line('added', 'const label = "新版预览";'),
      ]),
    ).toEqual([['旧'], ['新']]);
  });
  it('does not pair across context, hunks or missing-newline notes', () => {
    expect(
      highlight([
        line('removed', 'const a = 1;'),
        line('context', 'context'),
        line('added', 'const a = 2;'),
      ]),
    ).toEqual([[], [], []]);
    expect(
      highlight([
        line('removed', 'const a = 1;'),
        line('note', 'no newline'),
        line('added', 'const a = 2;'),
        line('note', 'no newline'),
      ]),
    ).toEqual([['1'], [], ['2'], []]);
    const result = highlightDiffHunks([
      { header: '@@ -1 +0,0 @@', lines: [line('removed', 'const a = 1;')] },
      { header: '@@ -0,0 +1 @@', lines: [line('added', 'const a = 2;')] },
    ]);
    expect(result.every((hunk) => hunk.lines.every((entry) => !entry.segments))).toBe(true);
  });
  it('bounds work for large replacement blocks and long lines while preserving text', () => {
    const block = Array.from({ length: 150 }, (_, index) =>
      line('removed', `const value${index} = 1;`),
    ).concat(Array.from({ length: 150 }, (_, index) => line('added', `const value${index} = 2;`)));
    expect(highlight(block).every((parts) => parts.length === 0)).toBe(true);
    const before = 'const value = "' + 'old shared '.repeat(800) + '";';
    const after = 'const value = "' + 'new shared '.repeat(800) + '";';
    const parts = highlight([line('removed', before), line('added', after)]);
    expect(parts[0]!.join('')).toContain('old');
    expect(parts[1]!.join('')).toContain('new');
  });
});
