import { expect, it } from 'vitest';
import { formatTurnTps } from '../../src/web/lib/turn-tps';

it.each([
  [1200, 20_000, '60.0'],
  [10, 250, '40.0'],
  [0, 500, '0.0'],
  [1, 100_000, '<0.1'],
  [undefined, 1000, undefined],
  [100, undefined, undefined],
  [100, 0, undefined],
  [100, -1, undefined],
  [100, Infinity, undefined],
  [100, NaN, undefined],
  [-1, 1000, undefined],
  [NaN, 1000, undefined],
  [Infinity, 1000, undefined],
])('formats output=%s duration=%s as %s', (tokens, duration, expected) => {
  expect(formatTurnTps(tokens, duration)).toBe(expected);
});
