import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ControlHint } from './ControlHint';
import { Button } from './ui/button';
import { Icon } from './Icon';

export function ReplyCopyButton({ text }: { text: string }) {
  const copying = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function copy() {
    if (copying.current) return;
    copying.current = true;
    clearTimeout(resetTimer.current);
    setFeedback('idle');
    try {
      // Copy the original reply so Markdown, code fences and whitespace survive.
      await navigator.clipboard.writeText(text);
      setFeedback('copied');
      resetTimer.current = setTimeout(() => setFeedback('idle'), 2000);
    } catch {
      setFeedback('failed');
    } finally {
      copying.current = false;
    }
  }

  return (
    <span className="reply-copy-controls">
      <ControlHint asChild content={t('workspace:copy_reply_markdown')}>
        <Button
          variant="ghost"
          size="icon"
          className="reply-copy-button"
          aria-label={t('workspace:copy_reply')}
          onClick={() => void copy()}
        >
          <Icon name={feedback === 'copied' ? 'check' : 'copy'} size={14} />
        </Button>
      </ControlHint>
      <span className={`reply-copy-feedback reply-copy-${feedback}`} role="status">
        {feedback === 'copied' && t('common:copied')}
        {feedback === 'failed' && t('workspace:copy_failed_select_and_copy_the_reply_manually')}
      </span>
    </span>
  );
}
