import { describe, expect, it, vi } from 'vitest';
import { readThreadPage } from '../../src/web/lib/thread-pagination';
import type { ThreadSummary, ThreadSummaryPage } from '../../src/shared/types';

const thread = (id: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  projectId: 'a',
  title: id,
  source: 'appServer',
  status: 'idle',
  managed: false,
  pendingActionCount: 0,
  ...extra,
});
const page = (data: ThreadSummary[], nextCursor: string | null, seq = 1): ThreadSummaryPage => ({
  data,
  nextCursor,
  cursor: { serverEpoch: 'epoch', seq },
});
const options = () => ({
  projectId: 'a',
  archived: false,
  cursor: 'one',
  knownIds: new Set(['old']),
  isCurrent: () => true,
});

describe('filtered conversation pagination', () => {
  it('skips empty, foreign, hidden, archived and duplicate pages until a new conversation arrives', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page([], 'two'))
      .mockResolvedValueOnce(
        page(
          [
            thread('foreign', { projectId: 'b' }),
            thread('hidden', { historyVisible: false }),
            thread('archived', { archived: true }),
          ],
          'three',
          2,
        ),
      )
      .mockResolvedValueOnce(page([thread('old', { title: 'updated' })], 'four', 3))
      .mockResolvedValueOnce(page([thread('new'), thread('old', { title: 'latest' })], 'five', 4));
    const result = await readThreadPage({ ...options(), read });
    expect(read.mock.calls).toEqual([['one'], ['two'], ['three'], ['four']]);
    expect(result).toEqual(page([thread('old', { title: 'latest' }), thread('new')], 'five'));
  });

  it.each([false, true])(
    'uses the terminal cursor to end a filtered list (archived: %s)',
    async (archived) => {
      const read = vi
        .fn()
        .mockResolvedValueOnce(page([thread('old', { archived })], 'two'))
        .mockResolvedValueOnce(page([], null, 2));
      expect(await readThreadPage({ ...options(), archived, read })).toMatchObject({
        nextCursor: null,
      });
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['one', 'two'])(
    'rejects a repeated/cyclic cursor %s instead of claiming completion',
    async (next) => {
      const read = vi
        .fn()
        .mockResolvedValueOnce(page([], 'two'))
        .mockResolvedValueOnce(page([thread('new')], next));
      await expect(readThreadPage({ ...options(), read })).rejects.toThrow('游标未前进');
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  it('does not continue a superseded read after a refresh or archive switch', async () => {
    let current = true;
    const read = vi.fn(async () => {
      current = false;
      return page([], 'two');
    });
    expect(await readThreadPage({ ...options(), read, isCurrent: () => current })).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('propagates page failures for retry and bounds an endlessly advancing empty index', async () => {
    const failed = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(readThreadPage({ ...options(), read: failed })).rejects.toThrow('offline');
    let count = 0;
    const read = vi.fn(async () => page([], `page-${++count}`));
    await expect(readThreadPage({ ...options(), read })).rejects.toThrow('读取过多');
    expect(read).toHaveBeenCalledTimes(100);
  });
});
