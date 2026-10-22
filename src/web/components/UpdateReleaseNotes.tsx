import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { releaseNotesUrl, type ReleaseNotes } from '../../shared/release-notes';
import { request } from '../lib/api';
import { t } from '../i18n';
import { Button } from './ui/button';
import { MarkdownContent } from './MarkdownContent';

export function UpdateReleaseNotes({ version }: { version: string }) {
  const [notes, setNotes] = useState<ReleaseNotes>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ version, ...(attempt ? { refresh: '1' } : {}) });
    void request<ReleaseNotes>(
      `/api/updates/release-notes?${query}`,
      undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    )
      .then((result) => {
        if (result.version !== version) throw new Error('Release version mismatch');
        if (!controller.signal.aborted) setNotes(result);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setNotes({
            version,
            url: releaseNotesUrl(version),
            state: 'error',
            reason: 'unavailable',
          });
      });
    return () => controller.abort();
  }, [version, attempt]);

  return (
    <section className="update-release-notes" aria-label={t('updates:releaseNotes')}>
      <div className="update-release-notes-heading">
        <h3>{t('updates:releaseNotesFor', { version })}</h3>
        <a href={notes?.url ?? releaseNotesUrl(version)} target="_blank" rel="noopener noreferrer">
          {t('updates:viewOnGitHub')} <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>
      {notes?.state === 'available' ? (
        <div
          className="update-release-notes-content"
          role="region"
          aria-label={t('updates:releaseNotesContent')}
          tabIndex={0}
        >
          <MarkdownContent
            text={notes.body}
            externalBaseUrl={`https://github.com/yuzheng14/covro/blob/${encodeURIComponent(`v${version}`)}/`}
          />
        </div>
      ) : (
        <p className="subtle" role="status">
          {!notes
            ? t('updates:releaseNotesLoading')
            : notes.state === 'missing'
              ? t('updates:releaseNotesMissing')
              : notes.state === 'empty'
                ? t('updates:releaseNotesEmpty')
                : notes.reason === 'rateLimited'
                  ? t('updates:releaseNotesRateLimited')
                  : t('updates:releaseNotesFailed')}
        </p>
      )}
      {notes && notes.state !== 'available' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setNotes(undefined);
            setAttempt((value) => value + 1);
          }}
        >
          {t('settings:retry')}
        </Button>
      )}
    </section>
  );
}
