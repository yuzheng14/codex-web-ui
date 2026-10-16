import { describe, expect, it } from 'vitest';
import { formatTurnCompletedAt, formatTurnDuration } from '../../src/web/lib/turn-timing';

describe('turn duration', () => {
  it.each([
    [0, '0 秒'],
    [1, '不足 1 秒'],
    [999, '不足 1 秒'],
    [1000, '1 秒'],
    [59_999, '59 秒'],
    [60_000, '1 分'],
    [135_000, '2 分 15 秒'],
    [3_600_000, '1 小时'],
    [3_661_000, '1 小时 1 分 1 秒'],
    [90_061_000, '25 小时 1 分 1 秒'],
  ])('formats %i milliseconds as %s', (input, expected) => {
    expect(formatTurnDuration(input)).toBe(expected);
  });
  it.each([undefined, -1, NaN, Infinity])(
    'does not invent missing or invalid duration %s',
    (input) => {
      expect(formatTurnDuration(input)).toBeUndefined();
    },
  );
});

describe('turn completion timestamp', () => {
  it.each([
    ['Asia/Shanghai', '2026-10-15 00:01:15（UTC+08:00）'],
    ['America/Los_Angeles', '2026-10-14 09:01:15（UTC-07:00）'],
    ['Asia/Kathmandu', '2026-10-14 21:46:15（UTC+05:45）'],
    ['UTC', '2026-10-14 16:01:15（UTC+00:00）'],
  ])('shows an absolute date and the completion offset in %s', (zone, label) => {
    expect(formatTurnCompletedAt(Date.parse('2026-10-14T16:01:15Z'), zone)).toEqual({
      dateTime: '2026-10-14T16:01:15.000Z',
      label,
    });
  });
  it('uses the historical daylight saving offset', () => {
    expect(
      formatTurnCompletedAt(Date.parse('2026-01-14T16:01:15Z'), 'America/Los_Angeles')?.label,
    ).toBe('2026-01-14 08:01:15（UTC-08:00）');
  });
  it.each([undefined, -1, NaN, Infinity, 8.64e15 + 1])(
    'does not replace %s with the current date',
    (input) => {
      expect(formatTurnCompletedAt(input)).toBeUndefined();
    },
  );
});
