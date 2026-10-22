import { z } from 'zod';
import { releaseNotesUrl, type ReleaseNotes } from '../shared/release-notes.js';
import { validVersion } from '../shared/versions.js';

export const releaseNotesQuery = z.object({
  version: z
    .string()
    .max(128)
    .refine((value) => value === value.trim() && validVersion(value)),
  refresh: z.literal('1').optional(),
});
const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string().url(),
  body: z.string().nullable().optional(),
  draft: z.boolean(),
});

/** Per gateway, shared across tabs; never mix a moving npm channel with a release tag. */
export function createReleaseNotesLookup() {
  const cache = new Map<string, { notes: ReleaseNotes; expires: number }>();
  const pending = new Map<string, Promise<ReleaseNotes>>();
  async function load(version: string): Promise<ReleaseNotes> {
    const target = { version, url: releaseNotesUrl(version) };
    try {
      const response = await fetch(
        `https://api.github.com/repos/yuzheng14/covro/releases/tags/${encodeURIComponent(`v${version}`)}`,
        {
          headers: { accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        },
      );
      if (response.status === 404) return { ...target, state: 'missing' };
      if (response.status === 429 || response.status === 403)
        return { ...target, state: 'error', reason: 'rateLimited' };
      if (!response.ok) throw new Error('Release request failed');
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new Error('Release response too large');
      const release = releaseSchema.parse(JSON.parse(text));
      if (release.tag_name !== `v${version}`) throw new Error('Release tag mismatch');
      if (release.draft) return { ...target, state: 'missing' };
      // Only link to this repository and exact tag, even if upstream data is malformed.
      if (decodeURIComponent(release.html_url) !== decodeURIComponent(target.url))
        throw new Error('Release URL mismatch');
      return release.body?.trim()
        ? { ...target, url: release.html_url, state: 'available', body: release.body }
        : { ...target, url: release.html_url, state: 'empty' };
    } catch {
      return { ...target, state: 'error', reason: 'unavailable' };
    }
  }
  return async (version: string, refresh = false): Promise<ReleaseNotes> => {
    // Validate here as well so non-HTTP callers cannot construct arbitrary selectors.
    releaseNotesQuery.parse({ version });
    const cached = cache.get(version);
    if (!refresh && cached && cached.expires > Date.now()) return cached.notes;
    const existing = pending.get(version);
    if (existing) return existing;
    const request = load(version).then((notes) => {
      if (notes.state !== 'error') {
        cache.delete(version);
        if (cache.size >= 32) cache.delete(cache.keys().next().value!);
        cache.set(version, {
          notes,
          expires: Date.now() + (notes.state === 'available' ? 5 * 60_000 : 60_000),
        });
      }
      return notes;
    });
    pending.set(version, request);
    try {
      return await request;
    } finally {
      pending.delete(version);
    }
  };
}
