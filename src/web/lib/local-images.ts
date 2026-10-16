import { HttpError } from './api';

// Include recognizable but unsupported image formats so their links receive an
// explanatory preview error instead of navigating to a nonexistent web route.
const imageExtension = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?|heic|heif)$/i;
const scheme = /^[a-z][a-z\d+.-]*:/i;
const unsafePath = (value: string) =>
  Array.from(value).some(
    (character) =>
      character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

/** A server filesystem path, never a browser URL or an authorization decision. */
export function localImagePath(destination: string, imageSource = false): string | undefined {
  if (!destination || destination !== destination.trim() || unsafePath(destination))
    return undefined;
  let encodedPath: string;
  if (/^file:/i.test(destination)) {
    // Reject host shares, credentials, and malformed file: forms before URL parsing
    // can normalize them into something that resembles a local path.
    if (!/^file:\/\/(?:localhost)?\//i.test(destination)) return undefined;
    try {
      const url = new URL(destination);
      if (url.hostname && url.hostname !== 'localhost') return undefined;
      encodedPath = url.pathname;
    } catch {
      return undefined;
    }
  } else {
    if (scheme.test(destination) || destination.startsWith('//')) return undefined;
    encodedPath = destination.split(/[?#]/, 1)[0] ?? '';
  }
  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    return undefined;
  }
  if (
    !path ||
    path !== path.trim() ||
    path.startsWith('//') ||
    scheme.test(path) ||
    unsafePath(path)
  )
    return undefined;
  return imageSource || imageExtension.test(path) ? path : undefined;
}

export function localImageUrl(threadId: string, path: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/images?path=${encodeURIComponent(path)}`;
}

export async function fetchLocalImage(
  threadId: string,
  path: string,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(localImageUrl(threadId, path), {
    credentials: 'same-origin',
    headers: { Accept: 'image/png, image/jpeg, image/gif, image/webp, application/json' },
    signal,
  });
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok) {
    if (type === 'application/json') {
      const data: unknown = await response.json();
      if (data && typeof data === 'object' && 'error' in data) {
        const problem = data.error;
        if (
          problem &&
          typeof problem === 'object' &&
          'code' in problem &&
          typeof problem.code === 'string' &&
          'message' in problem &&
          typeof problem.message === 'string'
        )
          throw new HttpError(response.status, { code: problem.code, message: problem.message });
      }
    }
    throw new Error(
      response.status === 401 || response.status === 403
        ? '无法读取图片，请确认登录状态和文件访问权限。'
        : `图片加载失败（${response.status}），请重试。`,
    );
  }
  if (!type || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type))
    throw new Error(
      type === 'text/html'
        ? '登录可能已过期，请重新登录后预览图片。'
        : '服务器未返回支持的图片格式。',
    );
  return response.blob();
}
