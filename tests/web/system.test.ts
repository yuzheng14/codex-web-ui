import { describe, expect, it } from 'vitest';
import { SystemSnapshotGuard } from '../../src/web/lib/system';

describe('system snapshot ordering', () => {
  it('keeps a newer runtime or cross-tab confirmation event when an older HTTP read finishes', () => {
    const guard = new SystemSnapshotGuard();
    const staleRead = guard.beginRead();
    guard.runtimeEvent();
    expect(guard.canApplyRead(staleRead)).toBe(false);
    const refreshed = guard.beginRead();
    expect(guard.canApplyRead(refreshed)).toBe(true);
  });

  it('uses the most recently requested HTTP state when reconnect overlaps initial polling', () => {
    const guard = new SystemSnapshotGuard();
    const initialRead = guard.beginRead();
    const reconnectRead = guard.beginRead();
    expect(guard.canApplyRead(initialRead)).toBe(false);
    expect(guard.canApplyRead(reconnectRead)).toBe(true);
  });
});
