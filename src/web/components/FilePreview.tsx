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
      setError('文件加载超时，请重试。');
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
      setFeedback(`已复制 ${kind} 原文`);
      resetTimer.current = setTimeout(() => setFeedback(''), 2500);
    } catch {
      setView('source');
      setFeedback('复制失败，请在原文中手动选择复制。');
    } finally {
      copying.current = false;
    }
  }
  useEffect(() => {
    if (view === 'source') source.current?.focus({ preventScroll: true });
  }, [view]);

  return (
    <FilePreviewPanel
      label={`${kind} 文件预览`}
      closeLabel="关闭文件预览"
      title={path.split('/').at(-1) ?? path}
      subtitle={`${kind} 文件`}
      icon={<FileText size={19} className="file-preview-icon" aria-hidden="true" />}
      onClose={onClose}
      actions={
        <Button variant="secondary" size="sm" disabled={!file} onClick={() => void copy()}>
          {feedback.startsWith('已复制') ? <Check size={15} /> : <Copy size={15} />}
          复制原文
        </Button>
      }
    >
      <div className="file-preview-toolbar">
        <div role="group" aria-label="文件展示方式">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={view === 'preview'}
            onClick={() => setView('preview')}
          >
            预览
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={view === 'source'}
            onClick={() => setView('source')}
          >
            原文
          </Button>
        </div>
        <span>只读</span>
      </div>
      <p className="file-preview-feedback" role="status">
        {feedback}
      </p>
      <div
        className="file-preview-scroll"
        key={`${attempt}:${view}`}
        tabIndex={0}
        aria-label="文件内容"
      >
        {error ? (
          <div className="file-preview-error" role="alert">
            <FileText size={28} aria-hidden="true" />
            <h3>无法预览此文件</h3>
            <p>{error}</p>
            <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
              重新加载
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
              aria-label={`${kind} 原文`}
            >
              {file.content}
            </pre>
          )
        ) : (
          <p className="file-preview-loading" role="status">
            正在加载文件…
          </p>
        )}
      </div>
      <footer className="file-preview-path" title={file?.path ?? path}>
        {file?.path ?? path}
      </footer>
    </FilePreviewPanel>
  );
}
