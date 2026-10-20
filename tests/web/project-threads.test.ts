import { describe, expect, it } from 'vitest';
import type { RunStatus, ThreadSummary, ThreadSummaryPage } from '../../src/shared/types';
import { ProjectThreadsStore } from '../../src/web/lib/project-threads';

const cursor = (seq: number, serverEpoch = 'epoch') => ({ seq, serverEpoch });
const summary = (id: string, projectId = 'a', status: RunStatus = 'idle'): ThreadSummary => ({
  id,
  projectId,
  title: id,
  source: 'appServer',
  status,
  managed: true,
  pendingActionCount: status === 'waitingApproval' ? 1 : 0,
});
const page = (
  data: ThreadSummary[],
  seq: number,
  nextCursor: string | null = null,
): ThreadSummaryPage => ({
  data,
  nextCursor,
  cursor: cursor(seq),
});

describe('multi-project conversation overviews', () => {
  it('excludes drafts and removes rejected first sends without stale reads restoring them', () => {
    const store = new ProjectThreadsStore();
    store.applySummary({ ...summary('draft'), historyVisible: false }, cursor(1));
    expect(store.snapshot.a?.data).toEqual([]);
    store.applySummary({ ...summary('draft'), historyVisible: true }, cursor(2));
    expect(store.snapshot.a?.data).toHaveLength(1);
    const pending = store.beginRead('a');
    store.applySummary({ ...summary('draft'), historyVisible: false }, cursor(4));
    store.finishRead(pending, page([{ ...summary('draft'), historyVisible: true }], 3));
    expect(store.snapshot.a?.data).toEqual([]);
  });

  it('loads, paginates, and fails projects independently without dropping another project', () => {
    const store = new ProjectThreadsStore();
    const readA = store.beginRead('a');
    const readB = store.beginRead('b');
    store.finishRead(readB, page([summary('b1', 'b')], 1, 'more-b'));
    expect(store.snapshot.a?.loading).toBe(true);
    store.finishRead(readA, page([summary('a1')], 1, 'more-a'));
    const moreA = store.beginRead('a', true);
    store.finishRead(moreA, page([summary('a1'), summary('a2')], 2));
    const failedB = store.beginRead('b', true);
    store.failRead(failedB, 'Project history is unavailable');
    expect(store.snapshot.a?.data.map((entry) => entry.id)).toEqual(['a1', 'a2']);
    expect(store.snapshot.a?.nextCursor).toBeNull();
    expect(store.snapshot.b).toMatchObject({
      data: [summary('b1', 'b')],
      nextCursor: 'more-b',
      loading: false,
      error: 'Project history is unavailable',
    });
    expect(store.findProject('b1')).toBe('b');
  });

  it('keeps a newer live status and a new conversation when an earlier HTTP snapshot arrives late', async () => {
    const store = new ProjectThreadsStore();
    let resolve!: (value: ThreadSummaryPage) => void;
    const delayed = new Promise<ThreadSummaryPage>((done) => {
      resolve = done;
    });
    const read = store.beginRead('a');
    const response = delayed.then((value) => store.finishRead(read, value));
    store.applySummary(summary('existing', 'a', 'waitingApproval'), cursor(12));
    store.applySummary(summary('new-fork', 'a', 'running'), cursor(13));
    resolve(page([summary('existing', 'a', 'idle')], 10, 'older'));
    await response;
    expect(store.snapshot.a?.data).toContainEqual(summary('existing', 'a', 'waitingApproval'));
    expect(store.snapshot.a?.data).toContainEqual(summary('new-fork', 'a', 'running'));
    expect(store.snapshot.a?.loading).toBe(false);
    expect(store.snapshot.a?.nextCursor).toBe('older');
  });

  it('keeps the latest requested page and ignores late successes and failures', () => {
    const store = new ProjectThreadsStore();
    const old = store.beginRead('a');
    const fresh = store.beginRead('a');
    store.finishRead(fresh, page([summary('new')], 2));
    expect(store.finishRead(old, page([summary('old')], 1))).toBe(false);
    expect(store.failRead(old, 'outdated failure')).toBe(false);
    expect(store.snapshot.a?.data).toEqual([summary('new')]);
    expect(store.snapshot.a?.error).toBeUndefined();
  });

  it('invalidates pending reads when a project is removed and loads its restored history afresh', () => {
    const store = new ProjectThreadsStore();
    store.applySummary(summary('a1', 'a', 'running'), cursor(20));
    store.applySummary(summary('b1', 'b'), cursor(21));
    const pending = store.beginRead('a');
    store.removeProject('a');
    expect(store.snapshot.a).toBeUndefined();
    expect(store.findProject('a1')).toBeUndefined();
    expect(store.finishRead(pending, page([summary('a1')], 22))).toBe(false);
    expect(store.failRead(pending, 'late error')).toBe(false);
    expect(store.snapshot.a).toBeUndefined();
    expect(store.snapshot.b?.data).toEqual([summary('b1', 'b')]);

    const restored = store.beginRead('a');
    expect(store.finishRead(pending, page([summary('stale')], 23))).toBe(false);
    expect(store.finishRead(restored, page([summary('a1', 'a', 'completed')], 10))).toBe(true);
    expect(store.snapshot.a?.data).toEqual([summary('a1', 'a', 'completed')]);
  });

  it('does not roll a summary back on duplicate events or events predating its HTTP cursor', () => {
    const store = new ProjectThreadsStore();
    store.finishRead(store.beginRead('a'), page([summary('one', 'a', 'completed')], 20));
    expect(store.applySummary(summary('one', 'a', 'running'), cursor(19))).toBe(false);
    expect(store.applySummary(summary('one', 'a', 'completed'), cursor(20))).toBe(false);
    expect(store.applySummary(summary('one', 'a', 'running'), cursor(21))).toBe(true);
    expect(store.applySummary(summary('one', 'a', 'idle'), cursor(21))).toBe(false);
    expect(store.snapshot.a?.data[0]?.status).toBe('running');
  });

  it('preserves new-epoch live state against an in-flight old-epoch response, then accepts a new snapshot', () => {
    const store = new ProjectThreadsStore();
    store.applySummary(summary('one', 'a', 'running'), cursor(100));
    const old = store.beginRead('a');
    store.applySummary(summary('one', 'a', 'unknown'), cursor(1, 'restarted'));
    store.finishRead(old, page([summary('one', 'a', 'running')], 101));
    expect(store.snapshot.a?.data[0]?.status).toBe('unknown');
    const fresh = store.beginRead('a');
    store.finishRead(fresh, {
      ...page([summary('one', 'a', 'completed')], 3),
      cursor: cursor(3, 'restarted'),
    });
    expect(store.snapshot.a?.data[0]?.status).toBe('completed');
  });

  it('retains background project summaries without treating them as conversation history', () => {
    const store = new ProjectThreadsStore();
    store.applySummary(summary('background', 'b', 'waitingApproval'), cursor(1));
    store.finishRead(store.beginRead('a'), page([summary('foreground')], 2));
    expect(store.snapshot.b?.data[0]?.pendingActionCount).toBe(1);
    expect(store.snapshot.b?.data[0]).not.toHaveProperty('turns');
    expect(store.snapshot.b?.data[0]).not.toHaveProperty('actions');
  });
});

it('removes archived summaries and rejects stale reads that would restore them', () => {
  const store = new ProjectThreadsStore();
  store.applySummary(summary('one'), cursor(10));
  const pending = store.beginRead('a');
  store.applySummary({ ...summary('one'), archived: true }, cursor(12));
  store.finishRead(pending, page([summary('one')], 11));
  expect(store.snapshot.a?.data).toEqual([]);
  store.applySummary({ ...summary('one'), archived: false }, cursor(13));
  expect(store.snapshot.a?.data).toHaveLength(1);
});

it('invalidates in-flight pages when switching archive views and keeps live restores out of archived pages', () => {
  const store = new ProjectThreadsStore();
  const old = store.beginRead('a');
  store.setArchived(true);
  const current = store.beginRead('a');
  expect(store.finishRead(old, page([summary('old')], 10))).toBe(false);
  store.finishRead(current, page([{ ...summary('one'), archived: true }], 11, 'next'));
  const more = store.beginRead('a', true);
  store.applySummary({ ...summary('one'), archived: false }, cursor(13));
  store.finishRead(more, page([{ ...summary('one'), archived: true }], 12));
  expect(store.snapshot.a?.data).toEqual([]);
  store.setArchived(false);
  const active = store.beginRead('a');
  expect(store.failRead(more, 'late error')).toBe(false);
  store.finishRead(active, page([summary('one')], 14));
  expect(store.snapshot.a?.data).toHaveLength(1);
});

describe('optimistic archive projections', () => {
  const result = (row: ThreadSummary, seq: number, serverEpoch = 'epoch') => ({
    threadId: row.id,
    summary: row,
    cursor: cursor(seq, serverEpoch),
  });
  it('hides a pending archive across old list reads and inserts it in the archive filter', () => {
    const store = new ProjectThreadsStore();
    store.finishRead(store.beginRead('a'), page([summary('one'), summary('two')], 1, 'more'));
    store.beginMutation('archive', 'one', { projectId: 'a', archived: true });
    store.finishRead(store.beginRead('a'), page([summary('one'), summary('two')], 2, 'more'));
    expect(store.snapshot.a?.data.map((row) => row.id)).toEqual(['two']);
    expect(store.snapshot.a?.nextCursor).toBe('more');
    store.setArchived(true);
    expect(store.snapshot.a?.data).toEqual([{ ...summary('one'), archived: true }]);
    store.settleMutation('archive');
    expect(store.snapshot.a?.data ?? []).toEqual([]);
  });
  it.each(['receipt', 'event'])(
    'settles %s first without duplicate rows or a stale read restoring the source',
    (first) => {
      const store = new ProjectThreadsStore();
      store.applySummary(summary('one'), cursor(1));
      store.beginMutation('archive', 'one', { projectId: 'a', archived: true });
      const stale = store.beginRead('a');
      const archived = { ...summary('one'), archived: true };
      if (first === 'event') store.applySummary(archived, cursor(4));
      store.settleMutation('archive', result(archived, 4));
      if (first === 'receipt') store.applySummary(archived, cursor(4));
      store.finishRead(stale, page([summary('one')], 2));
      expect(store.snapshot.a?.data).toEqual([]);
      store.setArchived(true);
      store.finishRead(store.beginRead('a'), page([archived], 5));
      expect(store.snapshot.a?.data).toEqual([archived]);
    },
  );
  it('rolls back only the rejected mutation and preserves new server state and other pending rows', () => {
    const store = new ProjectThreadsStore();
    store.applySummary(summary('one'), cursor(1));
    store.applySummary(summary('two'), cursor(2));
    store.beginMutation('first', 'one', { projectId: 'a', archived: true });
    store.beginMutation('second', 'two', { projectId: 'a', archived: true });
    const newer = { ...summary('one'), title: 'newer server title', status: 'running' as const };
    store.applySummary(newer, cursor(5));
    store.settleMutation('first');
    expect(store.snapshot.a?.data).toEqual([newer]);
    store.settleMutation('second');
    expect(store.snapshot.a?.data).toContainEqual(summary('two'));
  });
  it('does not undo a later server archive change when an earlier receipt arrives', () => {
    const store = new ProjectThreadsStore();
    store.applySummary(summary('one'), cursor(1));
    store.beginMutation('archive', 'one', { projectId: 'a', archived: true });
    store.applySummary(
      { ...summary('one'), archived: false, title: 'restored elsewhere' },
      cursor(8),
    );
    store.settleMutation('archive', result({ ...summary('one'), archived: true }, 4));
    expect(store.snapshot.a?.data[0]).toMatchObject({
      archived: false,
      title: 'restored elsewhere',
    });
  });
  it('restores an unknown intent after reload without persisting its summary', () => {
    const store = new ProjectThreadsStore([
      {
        clientOperationId: 'restore',
        kind: 'archive',
        target: 'one',
        createdAt: 1,
        status: 'unknown',
        mutation: { projectId: 'a', archived: false },
      },
    ]);
    store.seedMutation('restore', { ...summary('one'), archived: true });
    expect(store.snapshot.a?.data).toEqual([{ ...summary('one'), archived: false }]);
    store.setArchived(true);
    expect(store.snapshot.a?.data).toEqual([]);
    store.settleMutation('restore');
    expect(store.snapshot.a?.data).toEqual([{ ...summary('one'), archived: true }]);
  });
  it('rejects a recovered receipt from an older gateway and removes mutations with their project', () => {
    const store = new ProjectThreadsStore();
    store.applySummary(summary('one'), cursor(1));
    store.beginMutation('archive', 'one', { projectId: 'a', archived: true });
    store.applySummary({ ...summary('one'), title: 'after restart' }, cursor(1, 'new'));
    store.settleMutation('archive', result({ ...summary('one'), archived: true }, 20));
    expect(store.snapshot.a?.data[0]?.title).toBe('after restart');
    store.beginMutation('next', 'one', { projectId: 'a', archived: true });
    store.removeProject('a');
    expect(store.snapshot.a).toBeUndefined();
  });
});

it('projects only the renamed title, and rolls back onto the latest server fields', () => {
  const store = new ProjectThreadsStore();
  store.applySummary(summary('one'), cursor(1));
  store.beginMutation('rename', 'one', { projectId: 'a', title: 'chosen title' });
  const latest = { ...summary('one'), title: 'newer external name', status: 'running' as const };
  store.applySummary(latest, cursor(4));
  expect(store.snapshot.a?.data[0]).toMatchObject({ title: 'chosen title', status: 'running' });
  store.settleMutation('rename');
  expect(store.snapshot.a?.data).toEqual([latest]);
});

describe('cached conversation list reconciliation', () => {
  const cached = (id: string): ThreadSummary => ({
    ...summary(id),
    status: 'unknown',
    managed: false,
  });
  it('retains cached tails after one page and only removes absent rows after a complete traversal', () => {
    const store = new ProjectThreadsStore();
    store.restoreCached('a', [cached('one'), cached('two'), cached('removed')]);
    store.finishRead(
      store.beginRead('a'),
      page([{ ...summary('one'), title: 'renamed elsewhere' }, summary('new')], 2, 'next'),
    );
    expect(store.snapshot.a?.data.map((row) => row.id)).toEqual(['new', 'one', 'removed', 'two']);
    expect(store.snapshot.a?.unverified).toEqual(['two', 'removed']);
    expect(store.snapshot.a?.nextCursor).toBe('next');
    store.finishRead(store.beginRead('a', true), page([summary('two'), summary('one')], 3));
    expect(store.snapshot.a?.data.map((row) => row.id)).toEqual(['new', 'one', 'two']);
    expect(store.snapshot.a?.unverified).toEqual([]);
  });
  it('ignores late cache rows superseded by HTTP, archive events, receipts or project removal', () => {
    const store = new ProjectThreadsStore();
    store.finishRead(store.beginRead('a'), page([summary('one')], 4, 'next'));
    store.applySummary({ ...summary('archived'), archived: true }, cursor(5));
    store.restoreCached('a', [cached('one'), cached('archived'), cached('tail')]);
    expect(store.snapshot.a?.data.map((row) => row.id)).toEqual(['one', 'tail']);
    expect(store.snapshot.a?.data[0]?.status).toBe('idle');
    store.beginMutation('rename', 'tail', { projectId: 'a', title: 'chosen name' });
    store.restoreCached('a', [cached('tail')]);
    expect(store.snapshot.a?.data[1]?.title).toBe('chosen name');
    const old = store.beginRead('a');
    store.settleMutation('rename', {
      threadId: 'tail',
      summary: { ...summary('tail'), title: 'chosen name' },
      cursor: cursor(9),
    });
    store.finishRead(old, page([summary('tail')], 6));
    expect(store.snapshot.a?.data).toEqual([{ ...summary('tail'), title: 'chosen name' }]);
    expect(store.restoreCached('a', [cached('gone')])).toBe(false);
  });
  it('leaves failed cached lists readable and discards them on forbidden results', () => {
    const store = new ProjectThreadsStore();
    const read = store.beginRead('a');
    store.restoreCached('a', [cached('one')]);
    store.failRead(read, 'offline');
    expect(store.snapshot.a).toMatchObject({
      data: [cached('one')],
      unverified: ['one'],
      error: 'offline',
      loading: false,
    });
    store.failRead(store.beginRead('a'), 'forbidden', undefined, true);
    expect(store.snapshot.a?.data).toEqual([]);
    expect(store.snapshot.a?.unverified).toBeUndefined();
  });
  it('never persists optimistic archive or title projections', () => {
    const store = new ProjectThreadsStore();
    store.restoreCached('a', [cached('one')]);
    store.beginMutation('rename', 'one', { projectId: 'a', title: 'pending' });
    store.beginMutation('archive', 'one', { projectId: 'a', archived: true });
    expect(store.snapshot.a?.data).toEqual([]);
    expect(store.cacheRows('a')).toEqual([cached('one')]);
  });
});

it('discards only unverified cached rows when cache identity changes, and blocks late forbidden cache reads', () => {
  const store = new ProjectThreadsStore();
  store.restoreCached('a', [summary('cached'), summary('live')]);
  store.applySummary(summary('live', 'a', 'running'), cursor(2));
  expect(store.discardCached()).toBe(true);
  expect(store.snapshot.a?.data).toEqual([summary('live', 'a', 'running')]);
  const denied = store.beginRead('a');
  store.failRead(denied, 'denied', undefined, true);
  expect(store.restoreCached('a', [summary('cached')])).toBe(false);
  expect(store.snapshot.a?.data).toEqual([]);
});

it('preserves new realtime rows observed between pages even when a later page has a newer global cursor', () => {
  const store = new ProjectThreadsStore();
  store.finishRead(store.beginRead('a'), page([summary('one')], 1, 'more'));
  store.applySummary(summary('new'), cursor(2));
  store.finishRead(store.beginRead('a', true), page([summary('two')], 3));
  expect(store.snapshot.a?.data.map((row) => row.id)).toEqual(['new', 'one', 'two']);
});

it('keeps confirmed archive, restore and rename metadata across filter changes and stale cache hydration', () => {
  const store = new ProjectThreadsStore();
  store.applySummary(summary('one'), cursor(1));
  store.applySummary({ ...summary('one'), archived: true, title: 'confirmed title' }, cursor(3));
  store.setArchived(true);
  store.restoreCached('a', [{ ...summary('one'), archived: true }]);
  expect(store.snapshot.a?.data[0]?.title).toBe('confirmed title');
  store.setArchived(false);
  store.restoreCached('a', [summary('one')]);
  expect(store.snapshot.a?.data ?? []).toEqual([]);
  store.applySummary({ ...summary('one'), title: 'restored name' }, cursor(5));
  store.setArchived(true);
  store.restoreCached('a', [{ ...summary('one'), archived: true }]);
  expect(store.snapshot.a?.data ?? []).toEqual([]);
  store.setArchived(false);
  store.restoreCached('a', [summary('one')]);
  expect(store.snapshot.a?.data[0]?.title).toBe('restored name');
});

it('retains absence from a complete server result across filter changes', () => {
  const store = new ProjectThreadsStore();
  store.restoreCached('a', [summary('removed')]);
  store.finishRead(store.beginRead('a'), page([], 2));
  store.setArchived(true);
  store.setArchived(false);
  store.restoreCached('a', [summary('removed')]);
  expect(store.snapshot.a?.data ?? []).toEqual([]);
});
