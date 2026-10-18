import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { MAX_THREAD_NAME_CHARACTERS, threadNameError } from '../../shared/thread-name';
import type { SlashCommand } from '../lib/slash-commands';
import { readableError } from '../lib/utils';
import { ControlHint } from './ControlHint';
import { Icon } from './Icon';
import { Button } from './ui/button';

/** Mount one editor per thread so drafts and late receipts cannot cross navigation. */
export function ThreadTitle({
  title,
  rename,
  pending,
}: {
  title: string;
  rename: SlashCommand;
  pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreTriggerFocus = useRef(false);
  const composing = useRef(false);
  const compositionEndedAt = useRef(-Infinity);
  const id = useId();
  const reason = rename.unavailableReason?.replaceAll('/status', '状态诊断');

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    if (editing && !saving && error) inputRef.current?.focus();
  }, [editing, saving, error]);

  useEffect(() => {
    if (!error || saving || pending || editing) return;
    if (title === draft.trim()) setError(undefined);
    else setEditing(true);
  }, [error, saving, pending, editing, title, draft]);

  useLayoutEffect(() => {
    if (!editing && restoreTriggerFocus.current) {
      restoreTriggerFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [editing]);

  function finish() {
    // A frame callback can precede React's commit or be throttled in a background tab.
    // Restore focus only after the trigger has been mounted again.
    restoreTriggerFocus.current = true;
    setEditing(false);
    setError(undefined);
  }

  async function save() {
    if (submitting.current || reason) return;
    const problem = draft.trim() ? threadNameError(draft) : '请输入会话名称。';
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    submitting.current = true;
    setSaving(true);
    setError(undefined);
    finish();
    try {
      const result = await rename.run(draft);
      if (result.error) setError(result.message.replaceAll('/status', '状态诊断'));
      else setError(undefined);
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return (
    <div className={`thread-title-editor${editing ? ' thread-title-editing' : ''}`}>
      {editing ? (
        <>
          <h1 className="sr-only">{title}</h1>
          <form
            className="thread-title-form"
            aria-label="重命名会话"
            aria-busy={saving}
            onSubmit={(event) => {
              event.preventDefault();
              if (!composing.current) void save();
            }}
          >
            <div className="thread-title-fields">
              <input
                ref={inputRef}
                aria-label="会话名称"
                aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
                aria-invalid={Boolean(error)}
                value={draft}
                disabled={saving}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(undefined);
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                  compositionEndedAt.current = performance.now();
                }}
                onBlur={() => {
                  composing.current = false;
                  compositionEndedAt.current = -Infinity;
                }}
                onKeyDown={(event) => {
                  if (
                    composing.current ||
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229
                  ) {
                    if (event.key === 'Enter') event.preventDefault();
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    if (!submitting.current) finish();
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (performance.now() - compositionEndedAt.current >= 100) void save();
                  }
                }}
                onKeyUp={(event) => {
                  if (event.key === 'Enter') compositionEndedAt.current = -Infinity;
                }}
              />
              <ControlHint content="保存会话名称">
                <Button
                  type="submit"
                  size="icon"
                  aria-label="保存会话名称"
                  disabled={saving || Boolean(reason)}
                >
                  <Icon name="check" size={16} />
                </Button>
              </ControlHint>
              <ControlHint content="取消重命名">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="取消重命名"
                  disabled={saving}
                  onClick={finish}
                >
                  <Icon name="close" size={16} />
                </Button>
              </ControlHint>
            </div>
            <p id={`${id}-help`} className="thread-title-help">
              {saving
                ? '正在保存…'
                : (reason ?? `Enter 保存 · Esc 取消 · 最多 ${MAX_THREAD_NAME_CHARACTERS} 个字符`)}
            </p>
            {error && (
              <p id={`${id}-error`} className="thread-title-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </>
      ) : (
        <ControlHint
          id={`${id}-hint`}
          className="thread-title-hint"
          content={reason ?? '点击标题重命名会话'}
        >
          <h1 aria-label={title}>
            <button
              ref={triggerRef}
              type="button"
              className="thread-title-trigger"
              aria-label="重命名会话"
              aria-describedby={`${id}-hint`}
              aria-disabled={Boolean(reason)}
              onClick={() => {
                if (reason) return;
                setDraft(title);
                setError(undefined);
                composing.current = false;
                compositionEndedAt.current = -Infinity;
                setEditing(true);
              }}
            >
              <span>{title}</span>
              <Pencil size={13} aria-hidden="true" />
            </button>
          </h1>
        </ControlHint>
      )}
    </div>
  );
}
