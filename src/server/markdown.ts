import { extname } from 'node:path';
import { AppError } from '../shared/errors.js';
import type { TextFile } from '../shared/types.js';
import { readLocalFile, type FileScope } from './local-files.js';

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export async function readLocalMarkdown(
  path: string | undefined,
  scope: FileScope,
): Promise<TextFile> {
  const file = await readLocalFile(path, scope, {
    code: 'MARKDOWN',
    label: 'Markdown',
    maxBytes: MAX_MARKDOWN_BYTES,
    sizeError: 'Markdown 文件超过 2 MiB 预览限制',
    validatePath(candidate) {
      if (!/^(\.md|\.markdown)$/i.test(extname(candidate)))
        throw new AppError('UNSUPPORTED_MARKDOWN_TYPE', '仅支持 .md 和 .markdown 文件', 415);
    },
  });
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
    if (content.includes('\0')) throw new Error('Binary content');
    return { path: file.path, content };
  } catch {
    throw new AppError('INVALID_MARKDOWN_CONTENT', '文件不是有效的 UTF-8 Markdown 文本', 415);
  }
}
