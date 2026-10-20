import { useEffect, useRef, useState, type RefObject } from 'react';
import { ControlHint } from './ControlHint';

/** Resize the bottom-anchored editor from its top edge, including outside the handle. */
export function ComposerResizeHandle({
  textareaRef,
  inputId,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  inputId: string;
}) {
  const [size, setSize] = useState({ min: 93, max: 230, height: 93 });
  const [resizing, setResizing] = useState(false);
  const limits = useRef(size);
  const drag = useRef<{ pointerId: number; y: number; height: number } | null>(null);

  function stopDragging() {
    drag.current = null;
    setResizing(false);
    document.documentElement.classList.remove('composer-resizing');
  }

  function resize(height: number) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const next = Math.min(limits.current.max, Math.max(limits.current.min, height));
    textarea.style.height = `${next}px`;
    setSize((previous) => ({ ...previous, height: next }));
  }

  useEffect(() => {
    const textarea = textareaRef.current;
    const bottom = textarea?.closest<HTMLElement>('.bottom-region');
    const panel = bottom?.parentElement;
    if (!textarea || !bottom || !panel) return;
    let frame = 0;
    const measure = () => {
      const style = getComputedStyle(textarea);
      const min = parseFloat(style.getPropertyValue('--composer-min-height'));
      const preferredMax = parseFloat(style.getPropertyValue('--composer-max-height'));
      const bottomMax = getComputedStyle(bottom).maxHeight;
      const available = bottomMax.endsWith('%')
        ? (panel.clientHeight * parseFloat(bottomMax)) / 100
        : parseFloat(bottomMax);
      const conversation = panel.querySelector<HTMLElement>('.conversation-area');
      const reserved = Array.from(panel.children).reduce((height, element) => {
        const style = getComputedStyle(element);
        if (
          element === bottom ||
          style.position === 'absolute' ||
          style.position === 'fixed' ||
          style.display === 'none'
        )
          return height;
        return (
          height +
          (element === conversation
            ? parseFloat(style.minHeight) || 0
            : element.getBoundingClientRect().height) +
          (parseFloat(style.marginTop) || 0) +
          (parseFloat(style.marginBottom) || 0)
        );
      }, 0);
      // Include attachments, notices, settings and footer in the shared space budget.
      const overhead = bottom.scrollHeight - textarea.getBoundingClientRect().height;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const viewportRoom = textarea.getBoundingClientRect().bottom - viewportTop - 24;
      const max = Math.max(
        min,
        Math.floor(
          Math.min(
            preferredMax,
            available - overhead,
            panel.clientHeight - reserved - overhead,
            viewportRoom,
          ),
        ),
      );
      textarea.style.setProperty('--composer-available-height', `${max}px`);
      if (textarea.style.height)
        textarea.style.height = `${Math.min(max, Math.max(min, parseFloat(textarea.style.height)))}px`;
      const height = textarea.getBoundingClientRect().height;
      limits.current = { min, max, height };
      setSize((previous) =>
        previous.min === min && previous.max === max && previous.height === height
          ? previous
          : { min, max, height },
      );
    };
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    const observer = new ResizeObserver(schedule);
    for (const element of [textarea, ...panel.children]) observer.observe(element);
    observer.observe(panel);
    const mutations = new MutationObserver(schedule);
    mutations.observe(panel, { childList: true });
    window.visualViewport?.addEventListener('resize', schedule);
    window.addEventListener('blur', stopDragging);
    measure();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.removeEventListener('blur', stopDragging);
      stopDragging();
    };
  }, [textareaRef]);

  return (
    <ControlHint
      asChild
      suppressed={resizing}
      content="向上拖动增高，向下拖动缩小；也可用方向键调整"
    >
      <button
        type="button"
        className="composer-resize-handle"
        role="separator"
        aria-label="调整输入框高度"
        aria-orientation="horizontal"
        aria-controls={inputId}
        aria-valuemin={Math.round(size.min)}
        aria-valuemax={Math.round(size.max)}
        aria-valuenow={Math.round(size.height)}
        aria-valuetext={`${Math.round(size.height)} 像素`}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || !textareaRef.current) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            y: event.clientY,
            height: textareaRef.current.getBoundingClientRect().height,
          };
          document.documentElement.classList.add('composer-resizing');
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          event.preventDefault();
          resize(drag.current.height + drag.current.y - event.clientY);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          stopDragging();
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={stopDragging}
        onLostPointerCapture={stopDragging}
        onKeyDown={(event) => {
          const height = textareaRef.current?.getBoundingClientRect().height ?? size.height;
          const step = event.shiftKey ? 40 : 10;
          const next = {
            ArrowUp: height + step,
            ArrowDown: height - step,
            Home: size.min,
            End: size.max,
          }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          resize(next);
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 4a16 16 0 0 1 16 16M10 4a10 10 0 0 1 10 10" />
        </svg>
      </button>
    </ControlHint>
  );
}
