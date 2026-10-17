import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Icon } from './Icon';

export function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const content = useRef<HTMLPreElement>(null);
  const copying = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function copy() {
    if (copying.current || !content.current) return;
    copying.current = true;
    clearTimeout(resetTimer.current);
    setFeedback('idle');
    try {
      // Read only the code, including its whitespace, at the moment of the click.
      await navigator.clipboard.writeText(content.current.textContent ?? '');
      setFeedback('copied');
      resetTimer.current = setTimeout(() => setFeedback('idle'), 2000);
    } catch {
      // Clipboard access can be unavailable on HTTP or denied by the browser.
      setFeedback('failed');
    } finally {
      copying.current = false;
    }
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-toolbar">
        <span className={`code-copy-feedback code-copy-${feedback}`} role="status">
          {feedback === 'copied' && '已复制'}
          {feedback === 'failed' && '复制失败，请手动选择代码复制。'}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="code-copy-button"
          aria-label="复制代码块"
          title="复制代码块"
          onClick={() => void copy()}
        >
          <Icon name={feedback === 'copied' ? 'check' : 'copy'} size={16} />
        </Button>
      </div>
      <pre ref={content} tabIndex={0} aria-label="代码块">
        {children}
      </pre>
    </div>
  );
}
