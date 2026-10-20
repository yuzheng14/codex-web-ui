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
      setFeedback('已复制 Mermaid 源码');
      resetTimer.current = setTimeout(() => setFeedback(''), 2000);
    } catch {
      setSourceView(true);
      setFeedback('复制失败，请在源码中手动选择复制。');
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
          {sourceView ? '查看图表' : '查看源码'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!current?.url || !!showSource}
          aria-pressed={actualSize}
          onClick={() => setActualSize((value) => !value)}
        >
          {actualSize ? '适应宽度' : '实际大小'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          复制源码
        </Button>
      </div>
      {feedback && (
        <p className="mermaid-feedback" role="status">
          {feedback}
        </p>
      )}
      {pending ? (
        <p className="mermaid-notice" role="status">
          正在接收 Mermaid 源码，代码块完整后显示图表。
        </p>
      ) : current?.failed ? (
        <p className="mermaid-notice mermaid-error" role="alert">
          Mermaid 图表无法渲染，请检查语法或复制源码到编辑器修正。
        </p>
      ) : !current?.url ? (
        <p className="mermaid-notice" role="status">
          正在渲染 Mermaid 图表…
        </p>
      ) : null}
      {showSource ? (
        <pre className="mermaid-source" tabIndex={0} aria-label="Mermaid 源码">
          <code>{source}</code>
        </pre>
      ) : current?.url ? (
        <div
          className={`mermaid-diagram${actualSize ? ' mermaid-actual-size' : ''}`}
          role="region"
          aria-label="Mermaid 图表区域"
          tabIndex={0}
        >
          <img
            src={current.url}
            alt="Mermaid 图表"
            onError={() => setResult({ source, dark, failed: true })}
          />
        </div>
      ) : null}
    </div>
  );
}
