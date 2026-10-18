import { compareVersions } from '../../src/shared/versions.js';
import { expect, it } from 'vitest';
import { releaseVersion } from '../../scripts/prepare-release.js';
it('uses unique CI identities for development snapshots without making them older than stable', () => {
  expect(releaseVersion('dev', '0.2.0', '12345', '2')).toBe('0.2.1-dev.12345.2');
  expect(() => releaseVersion('dev', '0.2.0', 'bad;command', '1')).toThrow('Invalid CI');
});
it('keeps stable releases tied to release-please and requires explicit beta versions', () => {
  expect(releaseVersion('stable', '0.2.0', '', '', '0.2.0')).toBe('0.2.0');
  expect(() => releaseVersion('stable', '0.2.0', '', '', '0.3.0')).toThrow('Stable version');
  expect(releaseVersion('beta', '0.2.0', '', '', '0.3.0-beta.1')).toBe('0.3.0-beta.1');
  expect(() => releaseVersion('beta', '0.2.0', '', '', '0.3.0')).toThrow('Beta version');
});

it('keeps first dev snapshots below the initial stable release, then advances after first publication', () => {
  const first = releaseVersion('dev', '0.1.0', '12345', '1', undefined, true);
  expect(first).toBe('0.1.0-dev.12345.1');
  expect(compareVersions(first, '0.1.0')).toBeLessThan(0);
  expect(releaseVersion('dev', '0.1.0', '12346', '1')).toBe('0.1.1-dev.12346.1');
});
