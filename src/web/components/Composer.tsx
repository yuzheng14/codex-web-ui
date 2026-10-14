import { useEffect, useRef, useState } from 'react';
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
  onResume: (confirmed: boolean) => void;
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
  const [confirmExternal, setConfirmExternal] = useState(false);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(-Infinity);
  const sendingRef = useRef(new Set<string>());
  const key = props.thread?.id ?? props.draftKey;
  useEffect(() => {
    setConfirmExternal(false);
    composingRef.current = false;
    compositionEndedAtRef.current = -Infinity;
  }, [key]);
  const text = drafts[key] ?? '';
  const active = isActive(props.thread?.status);
  const external = props.thread && !props.thread.managed;
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
      {external && (
        <div className="external-handoff">
          <strong>外部会话 · 活动状态未知</strong>
          <p>可直接 Fork 已保存的历史为新会话，无需停止原会话。新会话使用同一项目目录。</p>
          <Button size="sm" variant="secondary" disabled={!props.canFork} onClick={props.onFork}>
            <Icon name="fork" size={14} />
            {props.forking ? '正在确认 Fork…' : 'Fork 为新会话'}
          </Button>
          <p>要继续操作原会话，请先停止原 CLI 或编辑器中对此会话的操作。</p>
          <label>
            <input
              type="checkbox"
              checked={confirmExternal}
              onChange={(event) => setConfirmExternal(event.target.checked)}
            />
            我确认原会话已停止执行
          </label>
          <Button
            size="sm"
            disabled={!confirmExternal || props.disabled || props.resuming}
            onClick={() => props.onResume(confirmExternal)}
          >
            {props.resuming ? '正在恢复…' : '恢复并继续此会话'}
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
            <Button
              size="sm"
              onClick={() => {
                void send();
              }}
              disabled={!canSend}
            >
              <Icon name="send" size={14} />
              {props.submitting ? '正在提交…' : active ? '追加要求' : '发送任务'}
            </Button>
          </div>
        </div>
        <p className="keyboard-hint">Enter 发送 / Shift + Enter 换行</p>
      </div>
      <p className="composer-note">
        {active
          ? '关闭页面不会停止任务。中断以 Codex 返回的实际状态为准。'
          : 'Codex 使用本机项目与权限执行，请核对操作和变更。'}
      </p>
    </div>
  );
}
