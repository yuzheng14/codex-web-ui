import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { Button } from './ui/button';
import { ControlHint } from './ControlHint';
import { Icon } from './Icon';
import './command-output-copy.css';

export function CommandOutputCopyButton({
  output,
  truncated = false,
}: {
  output: string;
  truncated?: boolean;
}) {
  const copying = useRef(false);
  const mounted = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  async function copy() {
    if (copying.current || !output) return;
    copying.current = true;
    clearTimeout(resetTimer.current);
    setFeedback('idle');
    try {
      // The loaded output includes stdout/stderr in Codex's original order, even when hidden.
      await navigator.clipboard.writeText(output);
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
    <>
      <ControlHint asChild content={t('conversation:copy_loaded_command_output')}>
        <Button
          variant="ghost"
          size="icon"
          className="command-output-copy-button"
          aria-label={t('conversation:copy_command_output')}
          disabled={!output}
          onClick={(event) => {
            // A copy action must not toggle the containing native disclosure.
            event.preventDefault();
            event.stopPropagation();
            void copy();
          }}
        >
          <Icon name={feedback === 'copied' ? 'check' : 'copy'} size={16} />
        </Button>
      </ControlHint>
      <span
        className={`command-output-copy-feedback command-output-copy-${feedback}`}
        role="status"
      >
        {feedback === 'failed'
          ? t('conversation:command_output_copy_failed')
          : truncated
            ? t(
                feedback === 'copied'
                  ? 'conversation:copied_truncated_command_output'
                  : 'conversation:command_output_truncated',
              )
            : feedback === 'copied'
              ? t('common:copied')
              : ''}
      </span>
    </>
  );
}
