import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from '../../src/web/lib/api';

afterEach(() => vi.unstubAllGlobals());
describe('HTTP authentication and uncertain transport handling', () => {
  it('recognizes Access login HTML without treating it as JSON or retrying a mutation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(
      request('/api/threads/a/turns', { clientOperationId: 'same-id', text: 'task' }),
    ).rejects.toMatchObject({ status: 401, problem: { code: 'AUTH_REQUIRED' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves recognizable API error codes', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: 'ACTION_EXPIRED', message: '请求已失效' } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
    );
    await expect(request('/api/actions/old/resolve', {})).rejects.toMatchObject({
      name: 'HttpError',
      problem: { code: 'ACTION_EXPIRED' },
    });
  });
});
