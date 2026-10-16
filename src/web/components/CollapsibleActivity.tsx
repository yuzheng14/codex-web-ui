import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import './collapsible-activity.css';

/** Native disclosure state survives streamed updates; each sticky header owns its own card. */
export function CollapsibleActivity({
  className = '',
  label,
  summary,
  children,
  group = false,
}: {
  className?: string;
  label: string;
  summary: ReactNode;
  children: ReactNode;
  group?: boolean;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const restoreFrame = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(
    () => () => {
      if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
    },
    [],
  );

  return (
    <details
      ref={detailsRef}
      className={`collapsible-activity${group ? ' collapsible-activity-group' : ''} ${className}`}
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary
        aria-label={`${open ? '收起' : '展开'}${label}`}
        onClick={(event) => {
          const details = detailsRef.current;
          const scroll = details?.closest<HTMLElement>('.conversation-scroll');
          if (!details?.open || !scroll) return;

          const header = event.currentTarget;
          const offset = Number.parseFloat(getComputedStyle(header).top) || 0;
          const viewportTop = scroll.getBoundingClientRect().top + scroll.clientTop;
          // A normal, visible header should keep the browser's usual disclosure behavior.
          if (details.getBoundingClientRect().top >= viewportTop + offset) return;

          if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
          restoreFrame.current = requestAnimationFrame(() => {
            restoreFrame.current = undefined;
            if (!details.isConnected || details.open) return;
            // Collapse first, then locate the real header (which is no longer sticky).
            // Keep it below an outer group's header and preserve keyboard focus.
            const top = scroll.getBoundingClientRect().top + scroll.clientTop;
            scroll.scrollTop += details.getBoundingClientRect().top - top - offset - 8;
            header.focus({ preventScroll: true });
          });
        }}
      >
        {summary}
        <span className="activity-collapse-hint" aria-hidden="true">
          收起
        </span>
        <Icon name="chevron" size={14} />
      </summary>
      {children}
    </details>
  );
}
