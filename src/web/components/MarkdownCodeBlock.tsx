import { t } from '../i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui/button';
import { ControlHint } from './ControlHint';
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
          {feedback === 'copied' && t('common:copied')}
          {feedback === 'failed' && t('preview:copy_failed_select_and_copy_the_code_manually')}
        </span>
        <ControlHint asChild content={t('preview:copy_code_block')}>
          <Button
            variant="ghost"
            size="icon"
            className="code-copy-button"
            aria-label={t('preview:copy_code_block')}
            onClick={() => void copy()}
          >
            <Icon name={feedback === 'copied' ? 'check' : 'copy'} size={16} />
          </Button>
        </ControlHint>
      </div>
      <pre ref={content} tabIndex={0} aria-label={t('preview:code_block')}>
        {children}
      </pre>
    </div>
  );
}
