import { describe, expect, it } from 'vitest';
import type { ServerMessage, ThreadView } from '../../src/shared/types';
import { ProjectionCache, reconnectDelay } from '../../src/web/lib/realtime';
import { toThreadSummary } from '../../src/shared/thread-summary';

const thread = (id: string, text = ''): ThreadView => ({
  id,
  projectId: 'project',
  cwd: '/project',
  title: id,
  source: 'appServer',
  status: 'idle',
  managed: true,
  actions: [],
  turns: [
    {
      id: 'turn',
      threadId: id,
      status: 'completed',
      items: [{ id: 'item', type: 'agentMessage', text }],
    },
  ],
});
const snapshot = (id: string, seq: number, epoch = 'epoch'): ServerMessage => ({
  type: 'snapshot',
  threadId: id,
  cursor: { serverEpoch: epoch, seq },
  data: thread(id),
});
const update = (id: string, seq: number, text: string, epoch = 'epoch'): ServerMessage => ({
  type: 'event',
  kind: 'thread',
  threadId: id,
  cursor: { serverEpoch: epoch, seq },
  payload: thread(id, text),
});

describe('browser projection recovery', () => {
  it('requires a complete projection before accepting events or offering a replay cursor', () => {
    const cache = new ProjectionCache();
    expect(cache.apply(update('a', 12, 'partial'))).toBe(false);
    expect(cache.get('a')).toBeUndefined();
    cache.apply(snapshot('a', 12));
    expect(cache.get('a')?.cursor.seq).toBe(12);
    expect(new ProjectionCache().get('a')).toBeUndefined();
  });
  it('keeps cursors scoped to their threads and ignores duplicates without requiring contiguous global sequence', () => {
    const cache = new ProjectionCache();
    cache.apply(snapshot('a', 1));
    cache.apply(snapshot('b', 2));
    expect(cache.apply(update('a', 9, '你好'))).toBe(true);
    expect(cache.apply(update('a', 9, '重复'))).toBe(false);
    expect(cache.apply(update('a', 8, '过期'))).toBe(false);
    expect(cache.get('a')?.data.turns[0]?.items[0]?.text).toBe('你好');
    expect(cache.get('b')?.cursor.seq).toBe(2);
  });
  it('replaces state with a new-epoch snapshot instead of concatenating previous output', () => {
    const cache = new ProjectionCache();
    cache.apply(snapshot('a', 90));
    expect(cache.apply(update('a', 1, 'unknown', 'new'))).toBe(false);
    cache.apply(snapshot('a', 1, 'new'));
    cache.apply(update('a', 4, 'new content', 'new'));
    expect(cache.get('a')?.data.turns[0]?.items[0]?.text).toBe('new content');
    expect(cache.get('a')?.cursor).toEqual({ serverEpoch: 'new', seq: 4 });
  });
  it('bounds retry delay and applies jitter', () => {
    expect(reconnectDelay(0, () => 0)).toBe(525);
    expect(reconnectDelay(100, () => 1)).toBe(30_000);
    expect(reconnectDelay(100, () => 0)).toBeLessThan(30_000);
  });
  it('keeps overview events independent from detail snapshots and runtime cursors', () => {
    const cache = new ProjectionCache();
    const overview = (id: string, seq: number): ServerMessage => ({
      type: 'event',
      kind: 'threadSummary',
      threadId: id,
      cursor: { serverEpoch: 'epoch', seq },
      payload: toThreadSummary(thread(id)),
    });
    expect(cache.apply(overview('a', 8))).toBe(true);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.apply(overview('a', 8))).toBe(false);
    expect(cache.apply(overview('b', 6))).toBe(true);
    // A newer overview does not prevent an independent selected-thread replay.
    expect(cache.apply(snapshot('a', 1))).toBe(true);
    expect(cache.apply(update('a', 8, 'full conversation'))).toBe(true);
    expect(cache.get('a')?.data.turns[0]?.items[0]?.text).toBe('full conversation');
    const receipt: ServerMessage = {
      type: 'event',
      kind: 'operation',
      cursor: { serverEpoch: 'epoch', seq: 7 },
      payload: {
        clientOperationId: 'operation',
        kind: 'turn.start',
        target: 'a',
        status: 'acknowledged',
        createdAt: 1,
        updatedAt: 2,
      },
    };
    expect(cache.apply(receipt)).toBe(true);
    expect(cache.apply(receipt)).toBe(false);
    expect(cache.apply(overview('b', 9))).toBe(true);
    expect(cache.get('b')).toBeUndefined();
  });
});
