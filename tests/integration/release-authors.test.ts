import { expect, it, vi } from 'vitest';
import {
  releaseAuthorNotes,
  releaseCompatibilityNotes,
} from '../../scripts/release-compatibility.js';

const repository = 'example/covro';
const feature =
  '* **ui:** preview files ([#12](https://github.com/example/covro/issues/12)) ([abcdef1](https://github.com/example/covro/commit/abcdef1))';
const fix =
  '- recover startup ([123abcd](https://github.com/example/covro/commit/123abcd)), closes [#7](https://github.com/example/covro/issues/7)';

it('credits linked commit authors without changing grouping, ordering, scopes or references', () => {
  const body = `## 0.2.0\n\n### Features\n\n${feature}\n\n### Bug Fixes\n\n${fix}\n`;
  const lookup = vi.fn((sha: string) => (sha === 'abcdef1' ? 'alice' : 'bob'));
  const result = releaseAuthorNotes(body, repository, lookup);
  expect(result).toBe(body.replace(feature, `${feature} by @alice`).replace(fix, `${fix} by @bob`));
  expect(lookup.mock.calls).toEqual([['abcdef1'], ['123abcd']]);
  expect(releaseAuthorNotes(result, repository, lookup)).toBe(result);
  const metadata = { recommended: '0.163.0', verified: ['0.163.0'], unsupported: [] };
  const withCompatibility = releaseCompatibilityNotes(result, metadata);
  expect(withCompatibility.startsWith(result.trim())).toBe(true);
  expect(releaseAuthorNotes(withCompatibility, repository, lookup)).toBe(withCompatibility);
});

it('does not infer authors from issue links, another repository, paragraphs or code examples', () => {
  const body = [
    '### Features',
    '* issue only ([#12](https://github.com/example/covro/issues/12))',
    feature.replaceAll('example/covro/', 'example/covro-extra/'),
    feature.slice(2),
    '```md',
    feature,
    '```',
    '~~~md',
    fix,
    '~~~',
  ].join('\n');
  const lookup = vi.fn(() => 'alice');
  expect(releaseAuthorNotes(body, repository, lookup)).toBe(body);
  expect(lookup).not.toHaveBeenCalled();
});

it('caches repeated commits and preserves unlinked authors, whitespace and CRLF', () => {
  const body = `${feature}  \r\n${feature}\r\n${fix}\r\n`;
  const lookup = vi.fn((sha: string) => (sha === 'abcdef1' ? 'alice' : null));
  const result = releaseAuthorNotes(body, repository, lookup);
  expect(result).toBe(`${feature} by @alice  \r\n${feature} by @alice\r\n${fix}\r\n`);
  expect(lookup.mock.calls).toEqual([['abcdef1'], ['123abcd']]);
});

it('rejects malformed identities and propagates lookup failures before publishing', () => {
  const lookup = vi.fn(() => 'alice');
  expect(() => releaseAuthorNotes(feature, '../elsewhere', lookup)).toThrow('Invalid repository');
  expect(lookup).not.toHaveBeenCalled();
  expect(() => releaseAuthorNotes(feature, repository, () => '@wrong\nInjected notes')).toThrow(
    'Invalid GitHub author',
  );
  expect(() =>
    releaseAuthorNotes(feature, repository, () => {
      throw new Error('GitHub unavailable');
    }),
  ).toThrow('GitHub unavailable');
});
