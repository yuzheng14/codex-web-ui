/** The preview consumes Codex's saved patch, never the current working tree. */
export interface DiffLine {
  kind: 'added' | 'removed' | 'context' | 'note';
  text: string;
  oldLine?: number;
  newLine?: number;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  oldPath?: string;
  kind: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  metadata: string[];
  binary: boolean;
  incomplete: boolean;
}
export const diffKindLabels: Record<DiffFile['kind'], string> = {
  added: '新增',
  deleted: '删除',
  modified: '修改',
  renamed: '重命名',
};

function pathName(value: string, prefix = true) {
  let path = value.split('\t')[0]!;
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path
      .slice(1, -1)
      .replace(/(?:\\[0-7]{1,3})+/g, (escaped) =>
        new TextDecoder().decode(
          Uint8Array.from(
            [...escaped.matchAll(/\\([0-7]{1,3})/g)].map((match) => parseInt(match[1]!, 8)),
          ),
        ),
      )
      .replace(/\\([\\"tnr])/g, (_, char: string) => ({ t: '\t', n: '\n', r: '\r' })[char] ?? char);
  }
  return prefix ? path.replace(/^[ab]\//, '') : path;
}

export function parseDiff(input: string, fallback?: { path: string; kind: string }): DiffFile[] {
  // Strip terminal escape sequences (including OSC hyperlinks) before parsing or displaying.
  /* eslint-disable no-control-regex -- Terminal controls must be removed from saved patches. */
  const text = input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n');
  /* eslint-enable no-control-regex */
  if (!text.trim() && !fallback) return [];
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0,
    newLine = 0,
    oldLeft = 0,
    newLeft = 0;
  let hasOldHeader = false,
    hasNewHeader = false;
  const finishHunk = () => {
    if (file && hunk && (oldLeft !== 0 || newLeft !== 0)) file.incomplete = true;
    hunk = undefined;
  };
  const startFile = (path: string) => {
    finishHunk();
    file = {
      path,
      kind: 'modified',
      additions: 0,
      deletions: 0,
      hunks: [],
      metadata: [],
      binary: false,
      incomplete: false,
    };
    files.push(file);
    hasOldHeader = false;
    hasNewHeader = false;
    return file;
  };
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const paths = /^diff --git ("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(line);
      startFile(paths ? pathName(paths[2]!) : (fallback?.path ?? '未知文件'));
      continue;
    }
    // A line starting --- or +++ inside a hunk is source code, not a file header.
    if (hunk && (oldLeft > 0 || newLeft > 0) && /^[ +\-\\]/.test(line)) {
      if (line.startsWith('\\')) hunk.lines.push({ kind: 'note', text: '文件末尾没有换行' });
      else if (line.startsWith('+')) {
        hunk.lines.push({ kind: 'added', text: line.slice(1), newLine: newLine++ });
        newLeft--;
        file!.additions++;
      } else if (line.startsWith('-')) {
        hunk.lines.push({ kind: 'removed', text: line.slice(1), oldLine: oldLine++ });
        oldLeft--;
        file!.deletions++;
      } else {
        hunk.lines.push({
          kind: 'context',
          text: line.slice(1),
          oldLine: oldLine++,
          newLine: newLine++,
        });
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!file || hasNewHeader) startFile(fallback?.path ?? '未知文件');
      finishHunk();
      hasOldHeader = true;
      const path = pathName(line.slice(4));
      if (path === '/dev/null') file!.kind = 'added';
      else {
        file!.oldPath = path;
        file!.path = path;
      }
    } else if (line.startsWith('+++ ')) {
      file ??= startFile(fallback?.path ?? '未知文件');
      hasNewHeader = true;
      const path = pathName(line.slice(4));
      if (path === '/dev/null') file.kind = 'deleted';
      else {
        file.path = path;
        if (file.oldPath && file.oldPath !== path) file.kind = 'renamed';
      }
    } else if (line.startsWith('@@')) {
      file ??= startFile(fallback?.path ?? '未知文件');
      finishHunk();
      const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!range) {
        file.incomplete = true;
        file.metadata.push(line);
        continue;
      }
      oldLine = Number(range[1]);
      newLine = Number(range[3]);
      oldLeft = Number(range[2] ?? 1);
      newLeft = Number(range[4] ?? 1);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (line.startsWith('\\ No newline') && hunk) {
      hunk.lines.push({ kind: 'note', text: '文件末尾没有换行' });
    } else if (line || file) {
      file ??= startFile(fallback?.path ?? '未知文件');
      if (line.startsWith('[输出已截断') || line.startsWith('[内容已截断')) file.incomplete = true;
      if (line.startsWith('new file mode')) file.kind = 'added';
      else if (line.startsWith('deleted file mode')) file.kind = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.oldPath = pathName(line.slice(12), false);
        file.kind = 'renamed';
      } else if (line.startsWith('rename to ')) {
        file.path = pathName(line.slice(10), false);
        file.kind = 'renamed';
      }
      if (/^(Binary files |GIT binary patch)/.test(line)) file.binary = true;
      // Binary payload is not useful in a text preview.
      if (!file.binary && !line.startsWith('index ') && line) file.metadata.push(line);
    }
  }
  finishHunk();
  if (!files.length && fallback) startFile(fallback.path);
  if (fallback && files.length === 1) {
    if (!hasOldHeader && !hasNewHeader) file!.path = fallback.path;
    if (fallback.kind === 'add') file!.kind = 'added';
    if (fallback.kind === 'delete') file!.kind = 'deleted';
  }
  return files;
}
