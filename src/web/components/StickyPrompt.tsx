import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ItemView, ThreadView } from '../../shared/types';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { UserMessage } from './UserMessage';

function PromptDialog({ item, onClose }: { item: ItemView; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="prompt-dialog"
      aria-labelledby="prompt-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="prompt-dialog-heading">
        <h2 id="prompt-dialog-title">完整 Prompt</h2>
        <Button variant="ghost" size="icon" aria-label="关闭完整 Prompt" onClick={onClose}>
          <Icon name="close" size={17} />
        </Button>
      </div>
      <div className="prompt-dialog-content" tabIndex={0} aria-label="Prompt 内容">
        <UserMessage item={item} />
      </div>
    </dialog>
  );
}

/** An overlay keeps the original prompt's geometry unchanged while reading replies. */
export function StickyPrompt({ thread }: { thread?: ThreadView }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string>();
  const [viewing, setViewing] = useState<ItemView>();
  const activePrompt = thread?.turns
    .flatMap((turn) => turn.items)
    .find((item) => item.type === 'userMessage' && item.id === activeId);

  const update = useCallback(() => {
    const scroll = slotRef.current?.parentElement?.querySelector('.conversation-scroll');
    if (!scroll) return;
    const top = scroll.getBoundingClientRect().top + scroll.clientTop;
    const prompts = scroll.querySelectorAll<HTMLElement>(
      '.conversation-content .user-message[data-prompt-id]',
    );
    let id: string | undefined;
    for (let index = prompts.length - 1; index >= 0; index--) {
      if (prompts[index]!.getBoundingClientRect().top < top) {
        id = prompts[index]!.dataset.promptId;
        break;
      }
    }
    setActiveId(id);
  }, []);

  useLayoutEffect(update, [thread, update]);
  useEffect(() => {
    const scroll = slotRef.current?.parentElement?.querySelector('.conversation-scroll');
    const content = scroll?.querySelector('.conversation-content');
    if (!scroll || !content) return;
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    };
    // Tool expansion, streamed text, image loading and viewport changes can all move prompts.
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    observer.observe(content);
    scroll.addEventListener('scroll', schedule, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener('scroll', schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [update]);

  const imageCount = Math.max(activePrompt?.imageCount ?? 0, activePrompt?.images?.length ?? 0);
  return (
    <div className="sticky-prompt-slot" ref={slotRef}>
      {activePrompt && (
        <Button
          variant="ghost"
          className="sticky-prompt"
          aria-label="查看完整 Prompt"
          aria-haspopup="dialog"
          title="查看完整 Prompt"
          onClick={() => setViewing(activePrompt)}
        >
          <span className="sticky-prompt-label">你的要求</span>
          <span className="sticky-prompt-text">
            {activePrompt.text?.trim() || (imageCount ? `${imageCount} 张图片` : '用户 Prompt')}
          </span>
          <Icon name="chevron" size={14} />
        </Button>
      )}
      {viewing && <PromptDialog item={viewing} onClose={() => setViewing(undefined)} />}
    </div>
  );
}
