import { useEffect, useId, useRef, useState } from 'react';
import type { ModelInfo, Settings, ThreadView } from '../../shared/types';
import { isActive } from './Status';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { SettingsPanel } from './SettingsPanel';

interface Props {
  thread?: ThreadView;
  draftKey: string;
  projectName?: string;
  settings: Settings;
  models: ModelInfo[];
  onSettings: (settings: Settings) => void;
  onSend: (text: string, steer: boolean) => Promise<boolean>;
  onInterrupt: () => void;
  onResume: () => void;
  canResume: boolean;
  resumeAttempted: boolean;
  disabled: boolean;
  canInterrupt: boolean;
  submitting: boolean;
  interrupting: boolean;
  resuming: boolean;
  canFork: boolean;
  forking: boolean;
  onFork: () => void;
}
export function Composer(props: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [shortcutDismissed, setShortcutDismissed] = useState(false);
  const shortcutId = useId();
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(-Infinity);
  const sendingRef = useRef(new Set<string>());
  const key = props.thread?.id ?? props.draftKey;
  useEffect(() => {
    composingRef.current = false;
    compositionEndedAtRef.current = -Infinity;
  }, [key]);
  useEffect(() => {
    // A hover hint must also dismiss when keyboard focus is still in the textarea.
    const dismissShortcut = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShortcutDismissed(true);
    };
    document.addEventListener('keydown', dismissShortcut);
    return () => document.removeEventListener('keydown', dismissShortcut);
  }, []);
  const text = drafts[key] ?? '';
  const active = Boolean(props.thread?.managed && isActive(props.thread.status));
  const external = props.thread && !props.thread.managed;
  const resumeError = external ? props.thread?.resumeError : undefined;
  const occupied = resumeError?.code === 'THREAD_IN_USE';
  const canSend = Boolean(
    props.thread && !external && text.trim() && !props.disabled && !props.submitting,
  );
  async function send() {
    if (!canSend || sendingRef.current.has(key)) return;
    sendingRef.current.add(key);
    const sent = text;
    try {
      if (await props.onSend(sent, active))
        setDrafts((previous) => (previous[key] === sent ? { ...previous, [key]: '' } : previous));
    } finally {
      sendingRef.current.delete(key);
    }
  }
  return (
    <div className="composer-region">
      {external && props.resuming && <p role="status">正在恢复会话…</p>}
      {external && props.resumeAttempted && !props.resuming && !resumeError && props.canResume && (
        <Button size="sm" variant="secondary" onClick={props.onResume}>
          重试恢复
        </Button>
      )}
      {resumeError && !props.resuming && (
        <div className="session-resume-notice" role="status">
          <strong>{occupied ? '此会话正被其他进程使用' : '无法恢复会话'}</strong>
          <p>
            {occupied
              ? '可以 Fork 已保存的历史继续对话，或在原进程释放会话后重试。新会话使用同一项目目录。'
              : resumeError.message}
          </p>
          {occupied && (
            <Button size="sm" variant="secondary" disabled={!props.canFork} onClick={props.onFork}>
              <Icon name="fork" size={14} />
              {props.forking ? '正在确认 Fork…' : 'Fork 为新会话'}
            </Button>
          )}
          <Button size="sm" disabled={!props.canResume} onClick={props.onResume}>
            重试恢复
          </Button>
        </div>
      )}
      <SettingsPanel settings={props.settings} models={props.models} onChange={props.onSettings} />
      <div className="composer-box">
        <textarea
          aria-label={active ? '追加要求' : '任务内容'}
          value={text}
          placeholder={
            !props.thread
              ? '新建或选择会话后，描述你的任务…'
              : active
                ? '补充要求或调整方向…'
                : '描述你想完成的任务…'
          }
          maxLength={100000}
          onChange={(event) =>
            setDrafts((previous) => ({ ...previous, [key]: event.target.value }))
          }
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            compositionEndedAtRef.current = performance.now();
          }}
          onBlur={() => {
            composingRef.current = false;
            compositionEndedAtRef.current = -Infinity;
          }}
          onKeyDown={(event) => {
            // A command menu may consume Enter before the composer handles it.
            if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey) return;
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229 ||
              composingRef.current
            )
              return;
            event.preventDefault();
            // Some IMEs end composition before the confirming Enter keydown.
            // Keyup releases this guard; the time limit also allows mouse commits.
            if (event.repeat || performance.now() - compositionEndedAtRef.current < 100) return;
            void send();
          }}
          onKeyUp={(event) => {
            if (event.key === 'Enter') compositionEndedAtRef.current = -Infinity;
          }}
          rows={3}
        />
        <div className="composer-actions">
          <span className="composer-target">
            <Icon name="folder" size={14} />
            {props.projectName ?? '未选择项目'}
          </span>
          <div>
            {active && (
              <Button
                variant="secondary"
                size="sm"
                onClick={props.onInterrupt}
                disabled={!props.canInterrupt || props.interrupting}
              >
                <Icon name="stop" size={13} />
                {props.interrupting ? '请求中…' : '中断'}
              </Button>
            )}
            <span
              className="composer-submit"
              data-tooltip-dismissed={shortcutDismissed || undefined}
              onMouseEnter={() => setShortcutDismissed(false)}
              onFocus={() => setShortcutDismissed(false)}
            >
              <Button
                size="sm"
                aria-describedby={shortcutId}
                onClick={() => {
                  void send();
                }}
                disabled={!canSend}
              >
                <Icon name="send" size={14} />
                {props.submitting ? '正在提交…' : active ? '追加要求' : '发送任务'}
              </Button>
              <span id={shortcutId} role="tooltip" className="keyboard-hint">
                Enter 发送 / Shift + Enter 换行
              </span>
            </span>
          </div>
        </div>
      </div>
      <p className="composer-note">
        {active
          ? '关闭页面不会停止任务。中断以 Codex 返回的实际状态为准。'
          : 'Codex 使用服务器项目与权限执行，请核对操作和变更。'}
      </p>
    </div>
  );
}
