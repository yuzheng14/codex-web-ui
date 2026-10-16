import { HttpError } from './api';
import type { ApiError } from '../../shared/types';

/** A same-origin Blob download also works on HTTP deployments without clipboard permissions. */
export async function downloadThreadExport(threadId: string): Promise<{ partial: boolean }> {
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/export`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'text/markdown' },
    signal: AbortSignal.timeout(35_000),
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('text/markdown')) {
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as { error?: ApiError };
      throw new HttpError(
        response.status,
        body.error ?? { code: 'EXPORT_FAILED', message: '无法读取会话历史，未下载文件。' },
      );
    }
    throw new HttpError(response.status === 200 ? 401 : response.status, {
      code: 'AUTH_REQUIRED',
      message: '登录已过期或历史接口未返回 Markdown，请重新登录后重试。',
    });
  }
  const filename = /filename="(codex-thread-[A-Za-z0-9_-]+\.md)"/.exec(
    response.headers.get('content-disposition') ?? '',
  )?.[1];
  if (!filename) throw new Error('导出响应缺少有效文件名，未下载文件。');
  const completeness = response.headers.get('x-export-completeness');
  if (completeness !== 'partial' && completeness !== 'saved-history')
    throw new Error('导出响应缺少历史完整性说明，未下载文件。');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Allow the browser to consume the URL before releasing its backing bytes.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { partial: completeness === 'partial' };
}
