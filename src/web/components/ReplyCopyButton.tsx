import { useEffect, useRef, useState } from 'react';
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
      <Button
        variant="ghost"
        size="icon"
        className="reply-copy-button"
        aria-label="复制回答"
        title="复制回答（Markdown）"
        onClick={() => void copy()}
      >
        <Icon name={feedback === 'copied' ? 'check' : 'copy'} size={14} />
      </Button>
      <span className={`reply-copy-feedback reply-copy-${feedback}`} role="status">
        {feedback === 'copied' && '已复制'}
        {feedback === 'failed' && '复制失败，请手动选择回答复制。'}
      </span>
    </span>
  );
}
