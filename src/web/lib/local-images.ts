import { message } from '../i18n/messages';
import { localFilePath } from './local-files';
import { HttpError } from './api';

// Include recognizable but unsupported image formats so their links receive an
// explanatory preview error instead of navigating to a nonexistent web route.
const imageExtension = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?|heic|heif)$/i;
export function localImagePath(destination: string, imageSource = false): string | undefined {
  const path = localFilePath(destination);
  return path && (imageSource || imageExtension.test(path)) ? path : undefined;
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
        ? message('preview:cannot_read_image_check_login_and_file_access')
        : message('preview:image_loading_failed_please_retry', { v0: response.status }),
    );
  }
  if (!type || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type))
    throw new Error(
      type === 'text/html'
        ? message('preview:your_login_may_have_expired_log_in_again')
        : message('preview:the_server_did_not_return_a_supported_image'),
    );
  return response.blob();
}
