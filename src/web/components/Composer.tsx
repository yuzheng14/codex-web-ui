import { useEffect, useId, useRef, useState, type ClipboardEvent } from 'react';
import { emptyDraft, imagePasteError, readImage, type MessageDraft } from '../lib/image-paste';
import type {
  ModelDefaults,
  ModelDefaultsResult,
  ModelInfo,
  Settings,
  ThreadView,
} from '../../shared/types';
import { isActive } from './Status';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { SettingsPanel } from './SettingsPanel';
import { SlashCommandMenu } from './SlashCommandMenu';
import {
  filterSlashCommands,
  parseSlashCommand,
  validateSlashCommand,
  type SlashCommand,
  type SlashCommandResult,
} from '../lib/slash-commands';
import { ControlHint } from './ControlHint';
import type { SentDraft } from '../lib/conversation-drafts';
import { useUpgradeReloadState } from '../lib/upgrade-reload';

interface Props {
  commands: SlashCommand[];
  thread?: ThreadView;
  threadLoading?: boolean;
  draftKey: string;
  sentDrafts: Record<string, SentDraft>;
  projectName?: string;
  projectId?: string;
  runtimeKey?: string;
  settings: Settings;
  models: ModelInfo[];
  onSettings: (settings: Settings) => void;
  onSaveModelDefaults: (settings: ModelDefaults) => Promise<ModelDefaultsResult | undefined>;
  savingModelDefaults: boolean;
  onSend: (text: string, steer: boolean, images?: string[]) => Promise<boolean>;
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
  const [drafts, setDrafts] = useState<Record<string, MessageDraft>>({});
  const draftsRef = useRef(drafts);
  const shortcutId = useId();
  const composingRef = useRef(false);
  useUpgradeReloadState(
    'composer',
    () => {
      if (
        composingRef.current ||
        Object.values(draftsRef.current).some((draft) =>
          draft.images.some((image) => !image.dataUrl),
        )
      )
        throw new Error('正在输入或读取图片，完成后会自动加载新版');
      return draftsRef.current;
    },
    (saved) => {
      draftsRef.current = { ...saved, ...draftsRef.current };
      setDrafts(draftsRef.current);
    },
  );
  const compositionEndedAtRef = useRef(-Infinity);
  const sendingRef = useRef(new Set<string>());
  const submittedDrafts = useRef(new Map<string, MessageDraft>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuId = useId();
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState({ key: '', text: '', selectedIndex: 0, dismissed: false });
  const [feedback, setFeedback] = useState<Record<string, SlashCommandResult>>({});
  const [commandPending, setCommandPending] = useState<string[]>([]);
  const key = props.draftKey;
  const consumedReceipts = useRef(new WeakSet<SentDraft>());
  useEffect(() => {
    for (const sent of Object.values(props.sentDrafts)) {
      if (consumedReceipts.current.has(sent)) continue;
      consumedReceipts.current.add(sent);
      if (submittedDrafts.current.get(sent.key)?.text.replace(/^(\s*)\/\//, '$1/') === sent.text)
        clearSubmittedDraft(sent.key);
    }
  }, [props.sentDrafts]);
  useEffect(() => {
    composingRef.current = false;
    compositionEndedAtRef.current = -Infinity;
    setMenu({ key: '', text: '', selectedIndex: 0, dismissed: false });
  }, [key]);
  const draft = drafts[key] ?? emptyDraft;
  const { text, images } = draft;
  const slash = parseSlashCommand(text);
  const matches = filterSlashCommands(props.commands, text);
  const currentMenu = menu.key === key && menu.text === text ? menu : undefined;
  const selectedIndex = Math.min(currentMenu?.selectedIndex ?? 0, Math.max(0, matches.length - 1));
  const menuOpen = Boolean(slash && focused && !currentMenu?.dismissed);
  const selectedCommand = menuOpen
    ? matches[selectedIndex]
    : props.commands.find((command) => command.name === slash?.name);
  const executingCommand = commandPending.includes(key);
  function selectCommand(index: number) {
    setMenu({ key, text, selectedIndex: index, dismissed: false });
  }
  function dismissMenu() {
    setMenu({ key, text, selectedIndex, dismissed: true });
  }
  async function executeCommand(command?: SlashCommand) {
    if (sendingRef.current.has(key) || composingRef.current) return;
    const current = draftsRef.current[key] ?? emptyDraft;
    const parsed = parseSlashCommand(current.text);
    if (!parsed) return;
    // Selection completes the name only. Arguments must still be validated and never discarded.
    const input = command
      ? `/${command.name}${parsed.arguments ? ` ${parsed.arguments}` : ''}`
      : current.text;
    const problem = current.images.length
      ? 'Slash 命令不能附带图片。请先移除图片，或改为普通消息。'
      : validateSlashCommand(input, props.commands);
    if (problem) {
      setFeedback((previous) => ({ ...previous, [key]: { message: problem, error: true } }));
      return;
    }
    const chosen = props.commands.find((entry) => entry.name === parseSlashCommand(input)?.name);
    if (!chosen) return;
    sendingRef.current.add(key);
    setCommandPending((previous) => [...previous, key]);
    setFeedback((previous) => ({ ...previous, [key]: { message: `正在执行 /${chosen.name}…` } }));
    dismissMenu();
    try {
      const result = await chosen.run(parseSlashCommand(input)?.arguments);
      setFeedback((previous) => ({ ...previous, [key]: result, [result.draftKey ?? key]: result }));
      if (!result.error) {
        updateDraft(key, (previous) => ({
          ...previous,
          text: previous.text === current.text ? '' : previous.text,
        }));
      }
    } catch (error) {
      setFeedback((previous) => ({
        ...previous,
        [key]: {
          error: true,
          message: error instanceof Error ? error.message : '命令执行失败，请重试。',
        },
      }));
    } finally {
      sendingRef.current.delete(key);
      setCommandPending((previous) => previous.filter((entry) => entry !== key));
    }
  }
  const readingImages = images.some((image) => !image.dataUrl);
  function updateDraft(draftKey: string, update: (draft: MessageDraft) => MessageDraft) {
    const next = {
      ...draftsRef.current,
      [draftKey]: update(draftsRef.current[draftKey] ?? emptyDraft),
    };
    draftsRef.current = next;
    setDrafts(next);
  }
  function clearSubmittedDraft(draftKey: string) {
    const sent = submittedDrafts.current.get(draftKey);
    if (!sent) return;
    submittedDrafts.current.delete(draftKey);
    updateDraft(draftKey, (previous) => ({
      text: previous.text === sent.text ? '' : previous.text,
      images: previous.images.filter(
        (image) => !sent.images.some((entry) => entry.id === image.id),
      ),
      error: previous.error === sent.error ? undefined : previous.error,
    }));
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (event.defaultPrevented) return;
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    // Plain text continues through the browser's native paste and IME handling.
    event.preventDefault();
    const current = draftsRef.current[key] ?? emptyDraft;
    const error = imagePasteError(files, current.images);
    if (error) {
      updateDraft(key, (previous) => ({ ...previous, error }));
      return;
    }
    const added = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name || '粘贴的图片',
      size: file.size,
    }));
    const pastedText = event.clipboardData.getData('text/plain');
    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;
    updateDraft(key, (previous) => ({
      text: pastedText
        ? (previous.text.slice(0, start) + pastedText + previous.text.slice(end)).slice(0, 100000)
        : previous.text,
      images: [...previous.images, ...added],
    }));
    files.forEach((file, index) => {
      const id = added[index]!.id;
      void readImage(file).then(
        (dataUrl) =>
          updateDraft(key, (previous) => ({
            ...previous,
            images: previous.images.map((image) =>
              image.id === id ? { ...image, dataUrl } : image,
            ),
          })),
        () =>
          updateDraft(key, (previous) =>
            previous.images.some((image) => image.id === id)
              ? {
                  ...previous,
                  images: previous.images.filter((image) => image.id !== id),
                  error: '图片读取失败，请重新粘贴。',
                }
              : previous,
          ),
      );
    });
  }
  const active = Boolean(props.thread?.managed && isActive(props.thread.status));
  const external = props.thread && !props.thread.managed && !props.thread.archived;
  const resumeError = external ? props.thread?.resumeError : undefined;
  const occupied = resumeError?.code === 'THREAD_IN_USE';
  const canSend = Boolean(
    (props.thread || props.projectId) &&
    !props.threadLoading &&
    !external &&
    (text.trim() || images.length) &&
    !readingImages &&
    !props.disabled &&
    !props.submitting,
  );
  async function send() {
    // Every submission path, including the button and a dismissed menu, uses this dispatcher.
    if (slash) {
      await executeCommand(menuOpen ? matches[selectedIndex] : undefined);
      return;
    }
    if (!canSend || sendingRef.current.has(key)) return;
    const current = draftsRef.current[key] ?? emptyDraft;
    if (!current.text.trim() && !current.images.length) return;
    if (current.images.some((image) => !image.dataUrl)) return;
    sendingRef.current.add(key);
    submittedDrafts.current.set(key, current);
    const sent = current.text;
    const sentImages = current.images;
    try {
      if (
        await props.onSend(
          sent.replace(/^(\s*)\/\//, '$1/'),
          active,
          sentImages.length ? sentImages.map((image) => image.dataUrl!) : undefined,
        )
      )
        clearSubmittedDraft(key);
    } finally {
      sendingRef.current.delete(key);
    }
  }
  return (
    <div className="composer-region">
      {props.submitting && (
        <p className="composer-resume-status" role="status">
          <Icon name="refresh" size={14} />
          {props.thread ? '正在提交消息…' : '正在创建会话并发送首条消息…'}
        </p>
      )}
      {external && props.resuming && (
        <p className="composer-resume-status" role="status">
          <Icon name="refresh" size={14} />
          正在恢复会话…
        </p>
      )}
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
      <div className="composer-box">
        {feedback[key] && (
          <p className="slash-feedback" role={feedback[key].error ? 'alert' : 'status'}>
            {feedback[key].message}
          </p>
        )}
        {menuOpen && (
          <SlashCommandMenu
            id={menuId}
            commands={matches}
            selectedIndex={selectedIndex}
            onSelect={selectCommand}
            onExecute={(command) => {
              textareaRef.current?.focus();
              void executeCommand(command);
            }}
          />
        )}
        {images.length > 0 && (
          <ul className="composer-images" aria-label="待发送的图片">
            {images.map((image, index) => (
              <li key={image.id}>
                {image.dataUrl ? (
                  <img src={image.dataUrl} alt={`待发送的图片 ${index + 1}`} />
                ) : (
                  <span role="status">读取中…</span>
                )}
                <ControlHint asChild content={image.name}>
                  <span className="composer-image-name">{image.name}</span>
                </ControlHint>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`移除图片 ${index + 1}`}
                  onClick={() =>
                    updateDraft(key, (previous) => ({
                      ...previous,
                      error: undefined,
                      images: previous.images.filter((entry) => entry.id !== image.id),
                    }))
                  }
                >
                  <Icon name="close" size={13} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {draft.error && (
          <p className="composer-image-error" role="alert">
            {draft.error}
          </p>
        )}
        <textarea
          ref={textareaRef}
          aria-label={active ? '追加要求' : '任务内容'}
          aria-haspopup="listbox"
          aria-controls={menuOpen ? menuId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            menuOpen && matches[selectedIndex]
              ? `${menuId}-${matches[selectedIndex].name}`
              : undefined
          }
          value={text}
          readOnly={Boolean(props.thread?.archived)}
          placeholder={
            props.thread?.archived
              ? '取消归档后可继续对话…'
              : active
                ? '补充要求或调整方向…'
                : '描述任务、粘贴图片，或输入 / 查看命令…'
          }
          maxLength={100000}
          onChange={(event) => {
            updateDraft(key, (previous) => ({ ...previous, text: event.target.value }));
            setMenu({ key, text: event.target.value, selectedIndex: 0, dismissed: false });
            setFeedback((previous) => {
              const next = { ...previous };
              delete next[key];
              return next;
            });
          }}
          onPaste={paste}
          onFocus={() => setFocused(true)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            compositionEndedAtRef.current = performance.now();
          }}
          onBlur={() => {
            setFocused(false);
            composingRef.current = false;
            compositionEndedAtRef.current = -Infinity;
          }}
          onKeyDown={(event) => {
            // A hovered Tooltip consumes Escape during document capture. The
            // focused editor must still close its own Slash menu on that key.
            if (event.defaultPrevented && !(menuOpen && event.key === 'Escape')) return;
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229 ||
              composingRef.current
            )
              return;
            // Some IMEs end composition before the confirming Enter keydown.
            // Keyup releases this guard; the time limit also allows mouse commits.
            if (performance.now() - compositionEndedAtRef.current < 100) {
              if (event.key === 'Enter' && !event.shiftKey) event.preventDefault();
              return;
            }
            if (menuOpen && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (matches.length)
                  selectCommand(
                    (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) %
                      matches.length,
                  );
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                dismissMenu();
                return;
              }
            }
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            if (event.repeat) return;
            void send();
          }}
          onKeyUp={(event) => {
            if (event.key === 'Enter') compositionEndedAtRef.current = -Infinity;
          }}
          rows={3}
        />
        <SettingsPanel
          settings={props.settings}
          projectName={props.projectName}
          models={props.models}
          onChange={props.onSettings}
          onSaveModelDefaults={props.onSaveModelDefaults}
          savingModelDefaults={props.savingModelDefaults}
          thread={props.thread}
          projectId={props.projectId}
          runtimeKey={props.runtimeKey}
          threadLoading={props.threadLoading}
          disabled={
            props.disabled ||
            Boolean(props.threadLoading) ||
            active ||
            props.submitting ||
            props.resuming ||
            props.forking
          }
        >
          {active && (
            <ControlHint content="中断">
              <Button
                aria-label={props.interrupting ? '请求中…' : '中断'}
                variant="secondary"
                size="sm"
                onClick={props.onInterrupt}
                disabled={!props.canInterrupt || props.interrupting}
              >
                <Icon name="stop" size={13} />
                <span className="composer-action-label">
                  {props.interrupting ? '请求中…' : '中断'}
                </span>
              </Button>
            </ControlHint>
          )}
          <ControlHint
            id={shortcutId}
            className="composer-submit"
            content={slash ? 'Enter 执行命令 / Esc 关闭菜单' : 'Enter 发送 / Shift + Enter 换行'}
          >
            <Button
              size="sm"
              aria-label={
                slash
                  ? executingCommand
                    ? '正在执行命令…'
                    : '执行命令'
                  : props.submitting
                    ? '正在提交…'
                    : active
                      ? '追加要求'
                      : '发送任务'
              }
              aria-describedby={shortcutId}
              onPointerDown={(event) => {
                if (slash) event.preventDefault();
              }}
              onClick={() => {
                void send();
              }}
              disabled={
                slash ? executingCommand || Boolean(selectedCommand?.unavailableReason) : !canSend
              }
            >
              <Icon name="send" size={14} />
              <span className="composer-action-label">
                {slash
                  ? executingCommand
                    ? '正在执行…'
                    : '执行命令'
                  : props.submitting
                    ? '正在提交…'
                    : active
                      ? '追加要求'
                      : '发送任务'}
              </span>
            </Button>
          </ControlHint>
        </SettingsPanel>
      </div>
      <p className="composer-note">
        {active
          ? '关闭页面不会停止任务。中断以 Codex 返回的实际状态为准。'
          : 'Codex 使用服务器项目与权限执行，请核对操作和变更。'}
      </p>
    </div>
  );
}
