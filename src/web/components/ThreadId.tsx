import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { ControlHint } from './ControlHint';

export function ThreadId({ id, placeholder }: { id?: string; placeholder?: string }) {
  return id ? <CopyableThreadId key={id} id={id} /> : <span>{placeholder ?? '会话尚未创建'}</span>;
}

function CopyableThreadId({ id }: { id: string }) {
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copying = useRef(false);
  const mounted = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  async function copy() {
    if (copying.current) return;
    copying.current = true;
    clearTimeout(resetTimer.current);
    setFeedback('idle');
    try {
      await navigator.clipboard.writeText(id);
      if (!mounted.current) return;
      setFeedback('copied');
      resetTimer.current = setTimeout(() => setFeedback('idle'), 2000);
    } catch {
      if (mounted.current) setFeedback('failed');
    } finally {
      copying.current = false;
    }
  }

  return (
    <div className="thread-id">
      <div className="thread-id-value">
        <code>{id}</code>
        <ControlHint asChild content="复制完整 Thread ID">
          <Button
            variant="ghost"
            size="icon"
            className="thread-id-copy"
            aria-label="复制 Thread ID"
            onClick={() => void copy()}
          >
            <Icon name={feedback === 'copied' ? 'check' : 'copy'} size={14} />
          </Button>
        </ControlHint>
      </div>
      <span className={`thread-id-feedback thread-id-${feedback}`} role="status">
        {feedback === 'copied' && '已复制'}
        {feedback === 'failed' && '复制失败，请手动选择 ID 复制。'}
      </span>
    </div>
  );
}
