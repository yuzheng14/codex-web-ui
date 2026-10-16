import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

export function ControlHint({
  id,
  content,
  children,
  suppressed = false,
  className,
}: {
  id: string;
  content: ReactNode;
  children: ReactNode;
  suppressed?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const suppressRestoredFocus = useRef(false);
  useEffect(() => {
    if (suppressed) {
      setOpen(false);
      suppressRestoredFocus.current = true;
    }
    // Closing a Select restores focus to its trigger. Only fresh keyboard
    // navigation may reopen on focus; Radix handles fresh hover separately.
    const allowKeyboardFocus = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && !suppressed) suppressRestoredFocus.current = false;
    };
    document.addEventListener('keydown', allowKeyboardFocus);
    return () => document.removeEventListener('keydown', allowKeyboardFocus);
  }, [suppressed]);

  return (
    <TooltipProvider>
      <Tooltip open={open && !suppressed} onOpenChange={(next) => setOpen(next && !suppressed)}>
        <TooltipTrigger
          asChild
          onFocus={(event) => {
            if (suppressRestoredFocus.current || !event.target.matches(':focus-visible'))
              event.preventDefault();
          }}
        >
          <span className={cn('control-hint', className)}>
            {children}
            <span id={id} className="sr-only control-hint-description">
              {content}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="end">
          <div className="control-hint-content">{content}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
