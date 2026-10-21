export const releasesUrl = 'https://github.com/yuzheng14/covro/releases';

export function releaseNotesUrl(version: string) {
  return `${releasesUrl}/tag/${encodeURIComponent(`v${version}`)}`;
}

export type ReleaseNotes = { version: string; url: string } & (
  | { state: 'available'; body: string }
  | { state: 'empty' }
  | { state: 'missing' }
  | { state: 'error'; reason: 'unavailable' | 'rateLimited' }
);
