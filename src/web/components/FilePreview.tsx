import { message, displayMessage, messageDetails } from '../i18n/messages';
import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Copy, FileText, Check } from 'lucide-react';
import { FilePreviewPanel } from './FilePreviewPanel';
import type { TextFile } from '../../shared/types';
import { api } from '../lib/api';
import { JsonContent } from './JsonContent';
import { readableError } from '../lib/utils';
import { Button } from './ui/button';
import { MarkdownContent } from './MarkdownContent';
import { ImagePreviewProvider } from './ImagePreview';

export function FilePreview({
  threadId,
  path,
  onClose,
}: {
  threadId: string;
  path: string;
  onClose: () => void;
}) {
  const kind = /\.json$/i.test(path) ? 'JSON' : 'Markdown';
  const source = useRef<HTMLPreElement>(null);
  const [file, setFile] = useState<TextFile>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [feedback, setFeedback] = useState('');
  const copying = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      setError(message('preview:file_loading_timed_out_please_retry'));
    }, 35_000);
    setFile(undefined);
    setError(undefined);
    void api
      .previewFile(threadId, path, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setFile(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(readableError(failure));
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [threadId, path, attempt]);

  async function copy() {
    if (!file || copying.current) return;
    copying.current = true;
    clearTimeout(resetTimer.current);
    setFeedback('');
    try {
      await navigator.clipboard.writeText(file.content);
      setFeedback(message('preview:copied_source', { v0: kind }));
      resetTimer.current = setTimeout(() => setFeedback(''), 2500);
    } catch {
      setView('source');
      setFeedback(message('preview:copy_failed_select_and_copy_the_source_manually'));
    } finally {
      copying.current = false;
    }
  }
  useEffect(() => {
    if (view === 'source') source.current?.focus({ preventScroll: true });
  }, [view]);

  return (
    <FilePreviewPanel
      label={t('preview:file_preview', { v0: kind })}
      closeLabel={t('preview:close_file_preview')}
      title={path.split('/').at(-1) ?? path}
      subtitle={t('preview:file', { v0: kind })}
      icon={<FileText size={19} className="file-preview-icon" aria-hidden="true" />}
      onClose={onClose}
      actions={
        <Button variant="secondary" size="sm" disabled={!file} onClick={() => void copy()}>
          {feedback.startsWith(t('common:copied')) ? <Check size={15} /> : <Copy size={15} />}
          {t('preview:copy_source')}
        </Button>
      }
    >
      <div className="file-preview-toolbar">
        <div role="group" aria-label={t('preview:file_display_mode')}>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={view === 'preview'}
            onClick={() => setView('preview')}
          >
            {t('preview:preview')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={view === 'source'}
            onClick={() => setView('source')}
          >
            {t('preview:source')}
          </Button>
        </div>
        <span>{t('common:read_only')}</span>
      </div>
      <p className="file-preview-feedback" role="status">
        {displayMessage(feedback)}
      </p>
      <div
        className="file-preview-scroll"
        key={`${attempt}:${view}`}
        tabIndex={0}
        aria-label={t('preview:file_content')}
      >
        {error ? (
          <div className="file-preview-error" role="alert">
            <FileText size={28} aria-hidden="true" />
            <h3>{t('preview:cannot_preview_this_file')}</h3>
            <p>{displayMessage(error)}</p>
            {messageDetails(error) && (
              <details>
                <summary>{t('common:technical_details')}</summary>
                <pre>{messageDetails(error)}</pre>
              </details>
            )}
            <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
              {t('common:reload')}
            </Button>
          </div>
        ) : file ? (
          view === 'preview' ? (
            kind === 'JSON' ? (
              <JsonContent content={file.content} />
            ) : (
              <ImagePreviewProvider threadId={threadId}>
                <MarkdownContent text={file.content} baseFile={file.path} />
              </ImagePreviewProvider>
            )
          ) : (
            <pre
              ref={source}
              className="file-preview-source"
              tabIndex={0}
              aria-label={t('preview:source_2', { v0: kind })}
            >
              {file.content}
            </pre>
          )
        ) : (
          <p className="file-preview-loading" role="status">
            {t('preview:loading_file')}
          </p>
        )}
      </div>
      <footer className="file-preview-path" title={file?.path ?? path}>
        {file?.path ?? path}
      </footer>
    </FilePreviewPanel>
  );
}
