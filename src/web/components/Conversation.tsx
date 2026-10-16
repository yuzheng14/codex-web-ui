import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ItemView, ThreadView, TurnView } from '../../shared/types';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive, Status } from './Status';
import { AutoReviewCard } from './AutoReviewCard';
import { CollapsibleActivity } from './CollapsibleActivity';
import { ActivityGroup } from './ActivityGroup';
import { groupConversationItems } from '../lib/activity-groups';

// Keep renderer identities stable so streamed text preserves table focus and scroll position.
const markdownComponents: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="markdown-table-scroll" role="region" aria-label="表格" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

function TextContent({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown skipHtml remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </Markdown>
    </div>
  );
}

const activityLabels: Record<string, string> = {
  commandExecution: '执行命令',
  fileChange: '文件变更',
  reasoning: '思考过程',
  mcpToolCall: '调用工具',
  webSearch: '搜索网页',
  plan: '执行计划',
  contextCompaction: '压缩上下文',
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
          <details className="file-change" key={`${change.path}:${index}`} open>
            <summary>
              <span className="change-kind">{change.kind}</span>
              <code>{change.path}</code>
            </summary>
            <Diff text={change.diff} />
          </details>
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

function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      <code>
        {text.split('\n').map((line, index) => (
          <span
            key={index}
            className={
              line.startsWith('+') && !line.startsWith('+++')
                ? 'diff-added'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'diff-removed'
                  : line.startsWith('@@')
                    ? 'diff-hunk'
                    : ''
            }
          >
            {line || ' '}
          </span>
        ))}
      </code>
    </pre>
  );
}

function itemsForDisplay(turn: TurnView): ItemView[] {
  return turn.items.map((item) => {
    if (item.type !== 'contextCompaction') return item;
    // Normalize before grouping so the collapsed summary and expanded card agree,
    // including a turn interrupted before item/completed arrives.
    const unfinished = !item.status || item.status === 'inProgress' || item.status === 'running';
    const status = unfinished && !isActive(turn.status) ? turn.status : item.status;
    return {
      ...item,
      status,
      text:
        status === 'completed'
          ? '上下文压缩已结束。'
          : (status === 'inProgress' || status === 'running') && isActive(turn.status)
            ? '正在压缩上下文，请等待当前任务结束。'
            : '本轮包含上下文压缩，请查看本轮任务状态及错误信息。',
    };
  });
}

function Item({ item }: { item: ItemView }) {
  if (item.type === 'autoApprovalReview' && item.autoReview) {
    return <AutoReviewCard review={item.autoReview} />;
  }
  if (
    item.type === 'userMessage' ||
    item.type === 'agentMessage' ||
    item.type === 'exitedReviewMode'
  ) {
    const user = item.type === 'userMessage';
    return (
      <article
        className={user ? 'message user-message' : 'message assistant-message'}
        aria-label={user ? '你的消息' : 'Codex 的回复'}
      >
        {!user && (
          <div className="message-avatar" aria-hidden="true">
            <Icon name="code" size={17} />
          </div>
        )}
        <div className="message-content">
          {!user && <div className="message-author">Codex</div>}
          {user ? <p className="user-text">{item.text}</p> : <TextContent text={item.text ?? ''} />}
          {user && item.images && (
            <div className="message-images">
              {item.images.map((image, index) => (
                <img key={index} src={image} alt={`已发送的图片 ${index + 1}`} loading="lazy" />
              ))}
            </div>
          )}
          {user && (item.imageCount ?? 0) > (item.images?.length ?? 0) && (
            <p className="subtle">
              {(item.imageCount ?? 0) - (item.images?.length ?? 0)} 张图片未提供预览
            </p>
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

export function Conversation({
  thread,
  offline,
  projectName,
  needsProject = false,
  canAddProject = true,
  onAddProject,
}: {
  thread?: ThreadView;
  offline: boolean;
  projectName?: string;
  needsProject?: boolean;
  canAddProject?: boolean;
  onAddProject?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showBottom, setShowBottom] = useState(false);
  const previousThread = useRef(thread?.id);
  const latestTurn = thread?.turns.at(-1);
  useEffect(() => {
    if (previousThread.current !== thread?.id) {
      previousThread.current = thread?.id;
      stickToBottom.current = true;
      setShowBottom(false);
    }
    if (stickToBottom.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread]);
  const updateScrollPosition = useCallback(() => {
    const box = containerRef.current;
    if (!box) return;
    stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    setShowBottom(!stickToBottom.current);
  }, []);
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
  return (
    <div className="conversation-area">
      {latestTurn?.reconnect && (
        <div className="codex-reconnect-pinned">
          <CodexReconnectNotice turn={latestTurn} offline={offline} />
        </div>
      )}
      <div className="conversation-scroll" ref={containerRef} onScroll={updateScrollPosition}>
        <div className="conversation-content">
          {thread?.historyTruncated && (
            <p className="truncation">
              <Icon name="alert" size={14} />
              当前实时快照已省略部分较早历史，以限制传输大小。
            </p>
          )}
          {!thread ? (
            <div className="empty-state">
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
                  选择会话继续，或在{projectName ? `「${projectName}」` : '项目'}中新建会话。
                  <br />
                  Codex 在运行服务的电脑上执行，你在这里掌握进展。
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
          ) : thread.turns.length === 0 ? (
            <div className="thread-empty">
              <Icon name="chat" size={28} />
              <h2>这个会话准备好了</h2>
              <p>描述你要完成的任务，也可以贴上问题或错误信息。</p>
            </div>
          ) : (
            thread.turns.map((turn, index) => (
              <section className="turn" key={turn.id} aria-label={`第 ${index + 1} 轮`}>
                <div className="turn-heading">
                  <span>第 {index + 1} 轮</span>
                  <Status status={turn.status} offline={offline} />
                </div>
                {turn.id !== latestTurn?.id && turn.reconnect?.status === 'failed' && (
                  <CodexReconnectNotice turn={turn} offline={offline} />
                )}
                {groupConversationItems(itemsForDisplay(turn)).map((group) =>
                  group.kind === 'message' ? (
                    <Item key={group.key} item={group.item} />
                  ) : (
                    <ActivityGroup key={group.key} items={group.items}>
                      {group.items.map((item) => (
                        <Item key={item.id} item={item} />
                      ))}
                    </ActivityGroup>
                  ),
                )}
                {turn.diff && (
                  <details className="turn-diff">
                    <summary>
                      <Icon name="code" size={16} />
                      本轮变更预览<span className="mono">{turn.id.slice(0, 12)}</span>
                    </summary>
                    <p className="subtle">由本轮 Codex 工具提供的变更</p>
                    <Diff text={turn.diff} />
                  </details>
                )}
                {turn.error && turn.reconnect?.status !== 'failed' && (
                  <div className="error-banner">{turn.error}</div>
                )}
              </section>
            ))
          )}
          <div ref={endRef} />
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
