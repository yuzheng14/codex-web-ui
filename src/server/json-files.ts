import { extname } from 'node:path';
import { AppError } from '../shared/errors.js';
import type { TextFile } from '../shared/types.js';
import { readLocalFile, type FileScope } from './local-files.js';

export const MAX_JSON_BYTES = 2 * 1024 * 1024;

export async function readLocalJson(path: string | undefined, scope: FileScope): Promise<TextFile> {
  const file = await readLocalFile(path, scope, {
    code: 'JSON',
    label: 'JSON',
    maxBytes: MAX_JSON_BYTES,
    sizeError: 'JSON 文件超过 2 MiB 预览限制',
    validatePath(candidate) {
      if (extname(candidate).toLowerCase() !== '.json')
        throw new AppError('UNSUPPORTED_JSON_TYPE', '仅支持 .json 文件', 415);
    },
  });
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
    return { path: file.path, content };
  } catch {
    throw new AppError('INVALID_JSON_CONTENT', '文件不是有效的 UTF-8 JSON 文本', 415);
  }
}
