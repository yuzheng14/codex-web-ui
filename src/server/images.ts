import { constants, realpathSync, statSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, parse, resolve } from 'node:path';
import { AppError } from '../shared/errors.js';
import { containsPath } from './projects.js';

/** Local output previews do not share the smaller inline prompt attachment budget. */
export const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ImageRoot {
  canonicalRoot: string;
  aliases: string[];
}

interface ImageScope {
  cwd: string;
  roots: readonly ImageRoot[];
}

/** Capture server-owned roots once; clients cannot nominate a temporary directory. */
export function temporaryImageRoots(): ImageRoot[] {
  const roots = new Map<string, ImageRoot>();
  for (const directory of [tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])]) {
    if (!isAbsolute(directory)) continue;
    const alias = resolve(directory);
    if (alias === parse(alias).root) continue;
    try {
      const canonicalRoot = realpathSync(alias);
      if (canonicalRoot === parse(canonicalRoot).root || !statSync(canonicalRoot).isDirectory())
        continue;
      const root = roots.get(canonicalRoot) ?? { canonicalRoot, aliases: [] };
      if (!root.aliases.includes(alias)) root.aliases.push(alias);
      roots.set(canonicalRoot, root);
    } catch {
      // Unavailable temp locations do not prevent previews in the remaining roots.
    }
  }
  return [...roots.values()];
}

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

function outsideProject(): AppError {
  return new AppError(
    'IMAGE_OUTSIDE_PROJECT',
    '只能预览当前会话所属项目或服务器临时目录内的图片',
    403,
  );
}

function changedImage(): AppError {
  return new AppError('IMAGE_CHANGED', '图片文件已变化，请重新打开预览', 409);
}

/** Read a bounded raster within server-authorized project/temp roots. Never accepts a URL. */
export async function readLocalImage(path: string | undefined, scope: ImageScope) {
  if (
    !path ||
    path.length > 4096 ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.startsWith('//') ||
    path.startsWith('\\\\')
  )
    throw new AppError('INVALID_IMAGE_PATH', '图片路径无效', 400);

  const candidate = resolve(scope.cwd, path);
  // Both spellings matter on systems where /tmp or the registered directory is an alias.
  if (
    !scope.roots.some(
      (root) =>
        containsPath(root.canonicalRoot, candidate) ||
        root.aliases.some((alias) => containsPath(alias, candidate)),
    )
  )
    throw outsideProject();
  const isAllowed = (path: string) =>
    scope.roots.some((root) => containsPath(root.canonicalRoot, path));
  const contentType = imageTypes[extname(candidate).toLowerCase()];
  if (!contentType)
    throw new AppError('UNSUPPORTED_IMAGE_TYPE', '仅支持 PNG、JPEG、WebP 和 GIF 图片', 415);

  try {
    const canonical = await realpath(candidate);
    if (!isAllowed(canonical)) throw outsideProject();
    // NOFOLLOW rejects a last-component symlink swapped in after realpath. NONBLOCK
    // ensures opening a substituted FIFO cannot leave the request waiting forever.
    const file = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new AppError('IMAGE_NOT_FILE', '图片路径不是普通文件', 415);
      if (before.size > MAX_LOCAL_IMAGE_BYTES)
        throw new AppError('IMAGE_TOO_LARGE', '图片超过 20 MiB 预览限制', 413);

      // Recheck the path and opened inode to detect ordinary concurrent replacements.
      // Node's portable file API cannot make parent-directory traversal race-free.
      const verifyPath = async () => {
        const current = await realpath(candidate);
        if (!isAllowed(current)) throw outsideProject();
        if (current !== canonical) throw changedImage();
        const currentStat = await stat(current);
        if (currentStat.dev !== before.dev || currentStat.ino !== before.ino) throw changedImage();
      };
      await verifyPath();
      // One extra byte detects growth without letting readFile allocate unbounded data.
      const data = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < data.length) {
        const { bytesRead } = await file.read(data, length, data.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_LOCAL_IMAGE_BYTES)
        throw new AppError('IMAGE_TOO_LARGE', '图片超过 20 MiB 预览限制', 413);
      const after = await file.stat();
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw changedImage();
      await verifyPath();
      const bytes = data.subarray(0, length);
      if (!matchesSignature(bytes, contentType))
        throw new AppError('INVALID_IMAGE_CONTENT', '文件内容与图片格式不符', 415);
      return { bytes, contentType };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new AppError('IMAGE_NOT_FOUND', '图片文件不存在或已被删除', 404);
    if (code === 'ELOOP') throw outsideProject();
    throw new AppError('IMAGE_UNREADABLE', '图片文件不可读取', 403);
  }
}
