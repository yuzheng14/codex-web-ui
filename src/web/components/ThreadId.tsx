import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { ControlHint } from './ControlHint';

export function ThreadId({ id, placeholder }: { id?: string; placeholder?: string }) {
  return id ? (
    <CopyableThreadId key={id} id={id} />
  ) : (
    <span>{placeholder ?? t('common:session_not_created_yet')}</span>
  );
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
        <ControlHint asChild content={t('sidebar:copy_full_thread_id')}>
          <Button
            variant="ghost"
            size="icon"
            className="thread-id-copy"
            aria-label={t('sidebar:copy_thread_id')}
            onClick={() => void copy()}
          >
            <Icon name={feedback === 'copied' ? 'check' : 'copy'} size={14} />
          </Button>
        </ControlHint>
      </div>
      <span className={`thread-id-feedback thread-id-${feedback}`} role="status">
        {feedback === 'copied' && t('common:copied')}
        {feedback === 'failed' && t('sidebar:copy_failed_select_and_copy_the_id_manually')}
      </span>
    </div>
  );
}
