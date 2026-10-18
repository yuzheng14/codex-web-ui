import { extname } from 'node:path';
import { AppError } from '../shared/errors.js';
import { readLocalFile, type FileScope } from './local-files.js';

export { temporaryFileRoots as temporaryImageRoots } from './local-files.js';
export type { FileRoot as ImageRoot } from './local-files.js';

export const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;

const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function matchesSignature(data: Buffer, contentType: string): boolean {
  switch (contentType) {
    case 'image/png':
      return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/gif':
      return ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('latin1'));
    case 'image/webp':
      return (
        data.length >= 12 &&
        data.subarray(0, 4).toString('latin1') === 'RIFF' &&
        data.subarray(8, 12).toString('latin1') === 'WEBP'
      );
    default:
      return false;
  }
}

export async function readLocalImage(path: string | undefined, scope: FileScope) {
  let contentType = '';
  const { bytes } = await readLocalFile(path, scope, {
    code: 'IMAGE',
    label: '图片',
    maxBytes: MAX_LOCAL_IMAGE_BYTES,
    sizeError: '图片超过 20 MiB 预览限制',
    validatePath(candidate) {
      contentType = imageTypes[extname(candidate).toLowerCase()] ?? '';
      if (!contentType)
        throw new AppError('UNSUPPORTED_IMAGE_TYPE', '仅支持 PNG、JPEG、WebP 和 GIF 图片', 415);
    },
  });
  if (!matchesSignature(bytes, contentType))
    throw new AppError('INVALID_IMAGE_CONTENT', '文件内容与图片格式不符', 415);
  return { bytes, contentType };
}
