import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import type { useProjectPath } from '../hooks/useProjectPath';
import { Button } from './ui/button';

export function ProjectPathPreview({ value }: { value: ReturnType<typeof useProjectPath> }) {
  return (
    <div className="project-path-preview" aria-live="polite">
      {value.error ? (
        <>
          <p className="inline-error" role="alert">
            {displayMessage(value.error)}
          </p>
          <Button variant="ghost" size="sm" onClick={value.retry}>
            {t('sidebar:path_retry')}
          </Button>
        </>
      ) : (
        <div className="project-directory">
          <span>{t('sidebar:resolved_path')}</span>
          <code>
            {value.pending ? t('sidebar:path_resolving') : value.ready ? value.path : '—'}
          </code>
        </div>
      )}
    </div>
  );
}
