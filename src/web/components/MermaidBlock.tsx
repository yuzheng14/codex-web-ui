import { message, displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { renderMermaid } from '../lib/mermaid';
import { Button } from './ui/button';

function useDarkDiagram() {
  const [dark, setDark] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return dark;
}

export function MermaidBlock({ source, pending }: { source: string; pending: boolean }) {
  const dark = useDarkDiagram();
  const [result, setResult] = useState<{
    source: string;
    dark: boolean;
    url?: string;
    failed?: boolean;
  }>();
  const [sourceView, setSourceView] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const [feedback, setFeedback] = useState('');
  const copying = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  useEffect(() => {
    if (pending) return;
    const controller = new AbortController();
    void renderMermaid(source, dark, controller.signal).then(
      (url) => {
        if (!controller.signal.aborted) setResult({ source, dark, url });
      },
      () => {
        if (!controller.signal.aborted) setResult({ source, dark, failed: true });
      },
    );
    return () => controller.abort();
  }, [source, dark, pending]);

  const current =
    !pending && result?.source === source && result.dark === dark ? result : undefined;
  const showSource = pending || current?.failed || sourceView;

  async function copy() {
    if (copying.current) return;
    copying.current = true;
    clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(source);
      setFeedback(message('preview:new_mermaid_source_copied'));
      resetTimer.current = setTimeout(() => setFeedback(''), 2000);
    } catch {
      setSourceView(true);
      setFeedback(message('preview:new_copy_failed_select_and_copy_the_source'));
    } finally {
      copying.current = false;
    }
  }

  return (
    <div className="mermaid-block" data-theme={dark ? 'dark' : 'light'}>
      <div className="mermaid-toolbar">
        <span className="mermaid-label">Mermaid</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!current?.url}
          aria-pressed={sourceView}
          onClick={() => setSourceView((value) => !value)}
        >
          {sourceView ? t('preview:new_view_diagram') : t('preview:new_view_source')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!current?.url || !!showSource}
          aria-pressed={actualSize}
          onClick={() => setActualSize((value) => !value)}
        >
          {actualSize ? t('preview:new_fit_width') : t('preview:new_actual_size')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          {t('preview:new_copy_source')}
        </Button>
      </div>
      {feedback && (
        <p className="mermaid-feedback" role="status">
          {displayMessage(feedback)}
        </p>
      )}
      {pending ? (
        <p className="mermaid-notice" role="status">
          {t('preview:new_receiving_mermaid_source_the_diagram_appears_when')}
        </p>
      ) : current?.failed ? (
        <p className="mermaid-notice mermaid-error" role="alert">
          {t('preview:new_cannot_render_this_mermaid_diagram_check_the')}
        </p>
      ) : !current?.url ? (
        <p className="mermaid-notice" role="status">
          {t('preview:new_rendering_mermaid_diagram')}
        </p>
      ) : null}
      {showSource ? (
        <pre className="mermaid-source" tabIndex={0} aria-label={t('preview:new_mermaid_source')}>
          <code>{source}</code>
        </pre>
      ) : current?.url ? (
        <div
          className={`mermaid-diagram${actualSize ? ' mermaid-actual-size' : ''}`}
          role="region"
          aria-label={t('preview:new_mermaid_diagram_region')}
          tabIndex={0}
        >
          <img
            src={current.url}
            alt={t('preview:new_mermaid_diagram')}
            onError={() => setResult({ source, dark, failed: true })}
          />
        </div>
      ) : null}
    </div>
  );
}
