import type { FileUpdateChange } from '../../src/codex/generated/v2/FileUpdateChange';

/** Stable multi-file patches, delivered through the fixture's real Codex protocol. */
export function diffPreviewChanges(scenario: string): FileUpdateChange[] {
  if (scenario.includes('empty')) return [];
  if (scenario.includes('invalid'))
    return [
      {
        path: 'unreadable.txt',
        kind: { type: 'update', move_path: null },
        diff: 'not a valid patch',
      },
    ];
  if (scenario.includes('inline'))
    return [
      {
        path: 'src/preview.ts',
        kind: { type: 'update', move_path: null },
        diff: [
          'diff --git a/src/preview.ts b/src/preview.ts',
          '--- a/src/preview.ts',
          '+++ b/src/preview.ts',
          '@@ -1,6 +1,7 @@',
          ' export function preview(user: string) {',
          '-  const mode = "light"; const retries = 3;',
          '+  const mode = "dark"; const retries = 5;',
          '-  const name = user;',
          '+  const name = userName;',
          '+  // Keep this newly added explanation visible.',
          '-  const icon = "👩🏽‍💻";',
          '+  const icon = "👨🏻‍💻";',
          '   return { mode, retries, name, icon };',
          ' }',
          '',
        ].join('\n'),
      },
    ];
  const path = 'src/预览 workspace.ts';
  const changes: FileUpdateChange[] = [
    {
      path,
      kind: { type: 'update', move_path: null },
      diff: [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -1,4 +1,5 @@',
        ' export function preview() {',
        '-  const layout = "terminal";',
        '+  const layout = "web";',
        '+  const readOnly = true;',
        '   return layout;',
        ' }',
        '@@ -20,160 +21,160 @@',
        ...Array.from({ length: 159 }, (_, index) => ` // Context line ${index + 20}`),
        '-const footer = "old";',
        `+const footer = "${'long-line-content '.repeat(35)}";`,
        '',
      ].join('\n'),
    },
    {
      path: 'docs/新功能.md',
      kind: { type: 'add' },
      diff: 'diff --git a/docs/新功能.md b/docs/新功能.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/新功能.md\n@@ -0,0 +1,2 @@\n+# 代码变更预览\n+只读，支持文件切换。\n',
    },
    {
      path: 'src/legacy.ts',
      kind: { type: 'delete' },
      diff: 'diff --git a/src/legacy.ts b/src/legacy.ts\ndeleted file mode 100644\n--- a/src/legacy.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const legacy = true;\n',
    },
    {
      path: 'assets/preview.png',
      kind: { type: 'update', move_path: null },
      diff: 'diff --git a/assets/preview.png b/assets/preview.png\nBinary files a/assets/preview.png and b/assets/preview.png differ\n',
    },
    {
      path: 'docs/guide.md',
      kind: { type: 'update', move_path: 'docs/readme.md' },
      diff: 'diff --git a/docs/guide.md b/docs/readme.md\nsimilarity index 100%\nrename from docs/guide.md\nrename to docs/readme.md\n',
    },
  ];
  if (scenario.includes('mixed')) {
    changes[0]!.diff = changes[0]!.diff.split('@@ -20')[0]!;
    changes.push({
      path: 'src/generated/large.ts',
      kind: { type: 'add' },
      diff:
        'diff --git a/src/generated/large.ts b/src/generated/large.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/generated/large.ts\n@@ -0,0 +1,480 @@\n' +
        Array.from({ length: 480 }, (_, i) => `+export const value${i} = ${i};`).join('\n') +
        '\n',
    });
  }
  if (scenario.includes('volume')) {
    changes.push({
      path: 'src/large-line.ts',
      kind: { type: 'add' },
      diff:
        'diff --git a/src/large-line.ts b/src/large-line.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/large-line.ts\n@@ -0,0 +1 @@\n+' +
        'long-line '.repeat(5100) +
        '\n',
    });
  }
  return changes;
}
