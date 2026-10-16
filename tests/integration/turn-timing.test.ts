import { describe, expect, it } from 'vitest';
import type { Turn } from '../../src/codex/generated/v2/Turn.js';
import { mapTurn } from '../../src/codex/mapping.js';
import { CodexAdapter } from '../../src/codex/adapter.js';
import { Projection } from '../../src/server/projection.js';
import { compactThreadForTransport } from '../../src/server/snapshot.js';
import { threadView } from './domain-helpers.js';

const turn: Turn = {
  id: 'turn-1',
  rootTurnId: null,
  status: 'completed',
  items: [],
  itemsView: 'full',
  error: null,
  startedAt: 1_792_000_000,
  completedAt: 1_792_000_135,
  durationMs: 134_789,
};

describe('upstream turn timing', () => {
  it('converts Unix seconds to milliseconds and preserves the authoritative duration independently', () => {
    expect(mapTurn('thread-1', turn)).toMatchObject({
      startedAt: 1_792_000_000_000,
      completedAt: 1_792_000_135_000,
      durationMs: 134_789,
    });
  });

  it.each([null, undefined, NaN, Infinity, -1])(
    'omits unavailable or invalid timing %s',
    (value) => {
      const mapped = mapTurn('thread-1', {
        ...turn,
        startedAt: value,
        completedAt: value,
        durationMs: value,
      } as Turn);
      expect(mapped).not.toHaveProperty('startedAt');
      expect(mapped).not.toHaveProperty('completedAt');
      expect(mapped).not.toHaveProperty('durationMs');
    },
  );

  it('keeps independently available timing, including an actual zero duration', () => {
    expect(mapTurn('thread-1', { ...turn, completedAt: null, durationMs: 0 })).toMatchObject({
      startedAt: 1_792_000_000_000,
      durationMs: 0,
    });
    const mapped = mapTurn('thread-1', { ...turn, durationMs: null });
    expect(mapped.completedAt).toBe(1_792_000_135_000);
    expect(mapped).not.toHaveProperty('durationMs');
  });

  it('retains completion through notifications, duplicate delivery, stale receipts and history snapshots', () => {
    const projection = new Projection();
    projection.thread(threadView('thread-1', '/workspace'));
    const adapter = new CodexAdapter({ binary: process.execPath });
    adapter.onEvent((event) => {
      if (event.type === 'turn') projection.turn(event.threadId, event.turn);
    });
    const running: Turn = { ...turn, status: 'inProgress', completedAt: null, durationMs: null };
    adapter['notification']({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: running },
    });
    for (let i = 0; i < 2; i++)
      adapter['notification']({ method: 'turn/completed', params: { threadId: 'thread-1', turn } });
    projection.turn('thread-1', mapTurn('thread-1', running), true);
    const snapshot = compactThreadForTransport(projection.get('thread-1')!, 4096);
    expect(snapshot.turns).toEqual([mapTurn('thread-1', turn)]);

    const restored = new Projection();
    restored.thread({
      ...threadView('thread-1', '/workspace'),
      turns: [mapTurn('thread-1', turn)],
    });
    expect(restored.get('thread-1')!.turns).toEqual(snapshot.turns);
    // A partial history response cannot erase timing already received from a completion event.
    projection.turn(
      'thread-1',
      mapTurn('thread-1', { ...turn, startedAt: null, completedAt: null, durationMs: null }),
    );
    expect(projection.get('thread-1')!.turns).toEqual(snapshot.turns);
  });
});
