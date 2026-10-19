import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AsyncQuestionReply, ItemView, ThreadView, TurnView } from '../../shared/types';
import { AsyncQuestionCard, type AsyncQuestionControls } from './AsyncQuestionCard';
import { asyncQuestionId } from '../../shared/async-questions';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive, Status } from './Status';
import { AutoReviewCard } from './AutoReviewCard';
import { CollapsibleActivity } from './CollapsibleActivity';
import { ActivityGroup } from './ActivityGroup';
import { groupConversationItems } from '../lib/activity-groups';
import { ContextCompaction } from './ContextCompaction';
import { TurnCompletion } from './TurnCompletion';

import { MarkdownContent as TextContent } from './MarkdownContent';
import { ImagePreviewProvider } from './ImagePreview';
import { UserMessage } from './UserMessage';
import { StickyPrompt } from './StickyPrompt';
import { useDiffPreview } from './FilePreviewProvider';

const activityLabels: Record<string, string> = {
  commandExecution: '执行命令',
  fileChange: '文件变更',
  reasoning: '思考过程',
  mcpToolCall: '调用工具',
  webSearch: '搜索网页',
  plan: '执行计划',
  enteredReviewMode: '开始代码审查',
  exitedReviewMode: '代码审查结果',
};
const activityStatusLabels: Record<string, string> = {
  completed: '已完成',
  inProgress: '执行中',
  running: '执行中',
  failed: '失败',
  declined: '已拒绝',
  interrupted: '已中断',
};

function Activity({ item }: { item: ItemView }) {
  const openDiff = useDiffPreview();
  return (
    <CollapsibleActivity
      className={`activity${item.status === 'failed' ? ' activity-failed' : ''}`}
      label={`${activityLabels[item.type] ?? item.type}${item.command ? `：${item.command}` : ''}`}
      summary={
        <>
          <Icon name={item.type === 'fileChange' ? 'code' : 'terminal'} size={16} />
          <span className="activity-description">
            <span className="activity-label">{activityLabels[item.type] ?? item.type}</span>
            {item.command && <code className="command-summary">{item.command}</code>}
          </span>
          <span className="activity-status">
            {item.status ? (activityStatusLabels[item.status] ?? item.status) : ''}
          </span>
        </>
      }
    >
      <div className="activity-body">
        {item.cwd && <p className="mono subtle">{item.cwd}</p>}
        {item.command && (
          <pre className="command">
            <code>$ {item.command}</code>
          </pre>
        )}
        {item.text && <TextContent text={item.text} />}
        {item.output !== undefined && (
          <pre className="tool-output">
            <code>{item.output || '暂无输出'}</code>
          </pre>
        )}
        {item.truncated && (
          <p className="truncation">
            <Icon name="alert" size={14} />
            输出超出显示上限，部分内容已截断。
          </p>
        )}
        {item.changes?.map((change, index) => (
          <Button
            className="file-change-link"
            variant="ghost"
            key={`${change.path}:${index}`}
            onClick={() =>
              openDiff({
                id: item.id,
                scope: '此工具的文件变更',
                source: 'item',
                selectedPath: change.path,
              })
            }
          >
            <Icon name="code" size={15} />
            <code>{change.path}</code>
            <span>查看变更</span>
            <Icon name="chevron" size={14} />
          </Button>
        ))}
        {item.error && <p className="inline-error">{item.error}</p>}
        {item.details !== undefined && (
          <details className="raw-details">
            <summary>活动详情</summary>
            <pre>{JSON.stringify(item.details, null, 2)}</pre>
          </details>
        )}
      </div>
    </CollapsibleActivity>
  );
}

function Item({
  item,
  questionControls,
  replies,
}: {
  item: ItemView;
  questionControls?: AsyncQuestionControls;
  replies?: AsyncQuestionReply[];
}) {
  if (item.type === 'contextCompaction') {
    return item.status === 'inProgress' ? null : <ContextCompaction item={item} />;
  }
  if (item.type === 'userMessage') return <UserMessage item={item} />;
  if (item.type === 'autoApprovalReview' && item.autoReview) {
    return <AutoReviewCard review={item.autoReview} />;
  }
  if (item.type === 'agentMessage' || item.type === 'exitedReviewMode') {
    return (
      <article className="message assistant-message" aria-label="Codex 的回复">
        <div className="message-content">
          {item.type === 'agentMessage' && item.questions?.length ? (
            <AsyncQuestionCard
              itemId={item.id}
              questions={item.questions}
              replies={replies}
              disabled={questionControls?.disabled ?? true}
              onReply={questionControls?.onReply ?? (async () => false)}
            />
          ) : (
            <TextContent text={item.text ?? ''} />
          )}
          {item.error && <p className="inline-error">{item.error}</p>}
        </div>
      </article>
    );
  }
  return <Activity item={item} />;
}

function CodexReconnectNotice({ turn, offline }: { turn: TurnView; offline: boolean }) {
  if (!turn.reconnect) return null;
  const retrying = turn.reconnect.status === 'retrying';
  return (
    <div
      className={`codex-reconnect codex-reconnect-${turn.reconnect.status}`}
      data-testid="codex-reconnect-status"
      data-state={turn.reconnect.status}
      role={retrying ? 'status' : 'alert'}
      aria-label="Codex 连接状态"
    >
      <Icon name={retrying ? 'refresh' : 'alert'} size={18} />
      <div className="codex-reconnect-content">
        <strong>
          {offline && '上次已知：'}
          {retrying ? 'Codex Reconnecting…' : 'Codex 重新连接失败'}
        </strong>
        <p>
          {retrying
            ? '正在重新连接模型服务，Codex 会自动重试。恢复后将继续当前任务。'
            : isActive(turn.status)
              ? 'Codex 已停止重试。请检查运行 Codex 的服务器网络与模型服务；若本轮仍未结束，可点击下方“中断”，结束后重新发送要求以继续。'
              : 'Codex 已停止重试。请检查运行 Codex 的服务器网络与模型服务，然后重新发送要求以继续。'}
        </p>
        <details>
          <summary>连接详情</summary>
          <p className="codex-reconnect-message">{turn.reconnect.message}</p>
        </details>
      </div>
    </div>
  );
}

interface ConversationProps {
  thread?: ThreadView;
  offline: boolean;
  history?: {
    cached?: boolean;
    cacheExhausted?: boolean;
    onLoadCachedOlder?: () => void;
    syncError?: string;
    loading: boolean;
    error?: string;
    onLoadOlder: () => void;
    opening: boolean;
    openingError?: string;
    onRetryOpen: () => void;
  };
  projectName?: string;
  needsProject?: boolean;
  canAddProject?: boolean;
  onAddProject?: () => void;
  questionControls?: AsyncQuestionControls;
  readingEnabled?: boolean;
  onReadCompleted?: (threadId: string, turnId: string) => void;
}

export function Conversation(props: ConversationProps) {
  // A thread change releases image requests, sticky prompts and modal focus state.
  return (
    <ImagePreviewProvider key={props.thread?.id ?? 'empty'} threadId={props.thread?.id}>
      <ConversationContent {...props} />
    </ImagePreviewProvider>
  );
}

function ConversationContent({
  thread,
  offline,
  history,
  projectName,
  needsProject = false,
  canAddProject = true,
  onAddProject,
  readingEnabled = true,
  onReadCompleted,
  questionControls,
}: ConversationProps) {
  const openDiff = useDiffPreview();
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showBottom, setShowBottom] = useState(false);
  const previousThread = useRef(thread?.id);
  const lastReadCompletion = useRef<{ threadId: string; turnId: string } | undefined>(undefined);
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const lastScrollTop = useRef(0);
  const scrollingUp = useRef(false);
  const userScrolled = useRef(false);
  const latestTurn = thread?.turns.at(-1);
  const questionReplies = new Map<string, AsyncQuestionReply[]>();
  for (const turn of thread?.turns ?? [])
    for (const item of turn.items)
      for (const reply of item.questionReplies ?? []) {
        const previous = questionReplies.get(reply.questionItemId) ?? [];
        questionReplies.set(reply.questionItemId, [...previous, reply]);
      }
  const activeCompaction =
    latestTurn && isActive(latestTurn.status)
      ? latestTurn.items.findLast(
          (item) => item.type === 'contextCompaction' && item.status === 'inProgress',
        )
      : undefined;
  useLayoutEffect(() => {
    if (previousThread.current !== thread?.id) {
      previousThread.current = thread?.id;
      stickToBottom.current = true;
      setShowBottom(false);
      anchor.current = undefined;
      scrollingUp.current = false;
      userScrolled.current = false;
    }
    const box = containerRef.current;
    if (stickToBottom.current) endRef.current?.scrollIntoView({ block: 'end' });
    else if (box && anchor.current) {
      const target = [...box.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
        (element) => element.dataset.turnId === anchor.current!.id,
      );
      if (target)
        box.scrollTop +=
          target.getBoundingClientRect().top -
          box.getBoundingClientRect().top -
          anchor.current.offset;
    }
    if (box) lastScrollTop.current = box.scrollTop;
  }, [thread]);
  const updateScrollPosition = useCallback(() => {
    const box = containerRef.current;
    if (!box) return;
    scrollingUp.current = userScrolled.current && box.scrollTop < lastScrollTop.current;
    lastScrollTop.current = box.scrollTop;
    const firstVisible = [...box.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
      (element) => element.getBoundingClientRect().bottom > box.getBoundingClientRect().top,
    );
    anchor.current = firstVisible
      ? {
          id: firstVisible.dataset.turnId!,
          offset: firstVisible.getBoundingClientRect().top - box.getBoundingClientRect().top,
        }
      : undefined;
    if (
      scrollingUp.current &&
      box.scrollTop < Math.max(600, box.clientHeight * 1.5) &&
      !history?.error
    )
      history?.onLoadOlder();
    stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    setShowBottom(!stickToBottom.current);
  }, [history]);
  useEffect(() => {
    const box = containerRef.current;
    if (
      box &&
      scrollingUp.current &&
      box.scrollTop < Math.max(600, box.clientHeight * 1.5) &&
      !history?.loading &&
      !history?.error
    )
      history?.onLoadOlder();
  }, [thread, history]);
  useEffect(() => {
    const box = containerRef.current;
    if (!box) return;
    const onToggle = (event: Event) => {
      // Expanding a long card need not scroll, but should stop following new output.
      if (
        event.target instanceof HTMLDetailsElement &&
        event.target.classList.contains('collapsible-activity')
      )
        updateScrollPosition();
    };
    box.addEventListener('toggle', onToggle, true);
    return () => box.removeEventListener('toggle', onToggle, true);
  }, [updateScrollPosition]);
  useEffect(() => {
    const box = containerRef.current;
    const end = endRef.current;
    const threadId = thread?.id;
    const turnId = latestTurn?.id;
    if (
      !readingEnabled ||
      !onReadCompleted ||
      !box ||
      !end ||
      !threadId ||
      !turnId ||
      latestTurn.status !== 'completed'
    )
      return;

    const reportRead = () => {
      if (
        document.visibilityState !== 'visible' ||
        !document.hasFocus() ||
        document.querySelector('dialog[open]') ||
        box.clientHeight === 0
      )
        return;
      const bounds = box.getBoundingClientRect();
      const ending = end.getBoundingClientRect();
      const visibleTop = Math.max(0, bounds.top + box.clientTop);
      const visibleBottom = Math.min(
        window.innerHeight,
        bounds.top + box.clientTop + box.clientHeight,
      );
      // The zero-height sentinel follows the last turn. Scrolling through older history
      // must not acknowledge a completion that remains below the visible conversation.
      if (visibleBottom <= visibleTop || ending.top < visibleTop || ending.bottom > visibleBottom)
        return;
      const previous = lastReadCompletion.current;
      if (previous?.threadId === threadId && previous.turnId === turnId) return;
      lastReadCompletion.current = { threadId, turnId };
      onReadCompleted(threadId, turnId);
    };

    const observer = new IntersectionObserver(reportRead, { root: box });
    observer.observe(end);
    box.addEventListener('scroll', reportRead);
    window.addEventListener('focus', reportRead);
    document.addEventListener('focusin', reportRead);
    document.addEventListener('close', reportRead, true);
    document.addEventListener('visibilitychange', reportRead);
    reportRead();
    return () => {
      observer.disconnect();
      box.removeEventListener('scroll', reportRead);
      window.removeEventListener('focus', reportRead);
      document.removeEventListener('focusin', reportRead);
      document.removeEventListener('close', reportRead, true);
      document.removeEventListener('visibilitychange', reportRead);
    };
  }, [thread?.id, latestTurn?.id, latestTurn?.status, readingEnabled, onReadCompleted]);
  return (
    <div className="conversation-area">
      {history?.cached && (
        <div className="history-cache-notice" role="status">
          <span>
            {history.syncError
              ? '显示本机缓存 · 同步失败，部分历史可能缺失。'
              : '显示本机缓存 · 正在核对最新消息与任务状态…'}
          </span>
          {history.syncError && (
            <Button variant="ghost" size="sm" onClick={history.onRetryOpen}>
              重新同步
            </Button>
          )}
        </div>
      )}
      {latestTurn?.reconnect && (
        <div className="codex-reconnect-pinned">
          <CodexReconnectNotice turn={latestTurn} offline={offline} />
        </div>
      )}
      {activeCompaction && (
        <div className="context-compaction-pinned">
          <ContextCompaction item={activeCompaction} offline={offline} />
        </div>
      )}
      <div className="conversation-viewport">
        <StickyPrompt
          thread={thread}
          onJump={() => {
            stickToBottom.current = false;
          }}
        />
        <div
          className="conversation-scroll"
          ref={containerRef}
          onScroll={updateScrollPosition}
          onWheel={() => {
            userScrolled.current = true;
          }}
          onTouchStart={() => {
            userScrolled.current = true;
          }}
          onPointerDown={() => {
            userScrolled.current = true;
          }}
          onKeyDown={(event) => {
            if (
              ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
            )
              userScrolled.current = true;
          }}
          tabIndex={0}
          aria-label="会话消息"
        >
          <div className="conversation-content">
            {(thread?.history?.olderCursor || history?.error) && (
              <div
                className="history-pagination"
                role="status"
                aria-live="polite"
                aria-busy={history?.loading}
              >
                <span>
                  {history?.error ??
                    (history?.loading ? '正在加载较早的消息…' : '向上滚动，加载更早的消息')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={history?.loading}
                  onClick={() => history?.onLoadOlder()}
                >
                  {history?.error ? '重试加载' : '加载更早的消息'}
                </Button>
                {history?.error && history.cached && thread?.history?.olderCursor && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={history.loading || history.cacheExhausted}
                    onClick={history.onLoadCachedOlder}
                  >
                    {history.cacheExhausted ? '此处尚无本机缓存' : '继续读取本机历史'}
                  </Button>
                )}
              </div>
            )}
            {thread?.historyTruncated && (
              <p className="truncation">
                <Icon name="alert" size={14} />
                当前实时快照已省略部分较早历史，以限制传输大小。
              </p>
            )}
            {history?.opening && !thread?.turns.length ? (
              <div className="history-opening" role={history.openingError ? 'alert' : 'status'}>
                <p>{history.openingError ?? '正在读取会话…'}</p>
                {history.openingError ? (
                  <Button variant="secondary" onClick={history.onRetryOpen}>
                    重试读取
                  </Button>
                ) : (
                  <div className="history-skeleton" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>
            ) : !thread?.turns.length ? (
              <div
                className="empty-state"
                data-testid="workspace-start"
                data-thread-ready={Boolean(thread)}
              >
                <div className="empty-symbol">
                  <Icon name="code" size={36} />
                </div>
                <p className="eyebrow">你的开发工作空间</p>
                <h1>{needsProject ? '添加项目，开始工作。' : '从一个想法，开始工作。'}</h1>
                {needsProject ? (
                  <>
                    <p>
                      连接服务器上已有的项目目录，继续历史会话或创建新任务。
                      <br />
                      项目会保存在服务器上，下次打开即可继续。
                    </p>
                    <Button onClick={onAddProject} disabled={!canAddProject}>
                      <Icon name="plus" size={16} />
                      添加项目
                    </Button>
                  </>
                ) : (
                  <p>
                    描述你要完成的任务，也可以粘贴图片、问题或错误信息。
                    <br />
                    发送后将在{projectName ? `「${projectName}」` : '当前项目'}中开始新会话。
                  </p>
                )}
                <div className="empty-features">
                  <span>
                    <Icon name="terminal" size={16} />
                    实时执行过程
                  </span>
                  <span>
                    <Icon name="code" size={16} />
                    逐轮变更预览
                  </span>
                  <span>
                    <Icon name="check" size={16} />
                    随时审批与追加
                  </span>
                </div>
              </div>
            ) : (
              thread.turns.map((turn, index) => (
                <section
                  className="turn"
                  key={turn.id}
                  data-turn-id={turn.id}
                  aria-label={`第 ${index + 1} 轮`}
                >
                  <div className="turn-heading">
                    <span>第 {index + 1} 轮</span>
                    <Status status={turn.status} offline={offline} />
                  </div>
                  {turn.id !== latestTurn?.id && turn.reconnect?.status === 'failed' && (
                    <CodexReconnectNotice turn={turn} offline={offline} />
                  )}
                  {groupConversationItems(turn.items).map((group) =>
                    group.kind === 'message' ? (
                      <Item
                        key={group.key}
                        item={group.item}
                        questionControls={questionControls}
                        replies={[
                          ...(questionReplies.get(group.item.id) ?? []),
                          ...(group.item.questions ?? []).flatMap(
                            (_, index) =>
                              questionReplies.get(asyncQuestionId(group.item.id, index)) ?? [],
                          ),
                        ]}
                      />
                    ) : (
                      <ActivityGroup key={group.key} items={group.items}>
                        {group.items.map((item) => (
                          <Item key={item.id} item={item} />
                        ))}
                      </ActivityGroup>
                    ),
                  )}
                  {(turn.diff !== undefined || turn.items.some((item) => item.changes?.length)) && (
                    <Button
                      className="turn-diff"
                      variant="ghost"
                      onClick={() =>
                        openDiff({
                          id: turn.id,
                          scope: `第 ${index + 1} 轮变更`,
                          source: 'turn',
                        })
                      }
                    >
                      <Icon name="code" size={17} />
                      <span>
                        本轮变更预览<small>查看文件与代码行变更</small>
                      </span>
                      <Icon name="chevron" size={16} />
                    </Button>
                  )}
                  {turn.error &&
                    turn.reconnect?.status !== 'failed' &&
                    !turn.items.some(
                      (item) => item.type === 'contextCompaction' && item.error === turn.error,
                    ) && <div className="error-banner">{turn.error}</div>}
                  <TurnCompletion turn={turn} />
                </section>
              ))
            )}
            <div ref={endRef} />
          </div>
        </div>
      </div>
      {showBottom && (
        <Button
          className="back-to-bottom"
          variant="secondary"
          size="sm"
          onClick={() => {
            stickToBottom.current = true;
            setShowBottom(false);
            endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }}
        >
          <Icon name="down" size={15} />
          回到最新内容
        </Button>
      )}
    </div>
  );
}
