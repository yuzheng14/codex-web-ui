import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { ItemView, ThreadView } from '../../shared/types';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { Status } from './Status';

function TextContent({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
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
    <details className={`activity${item.status === 'failed' ? ' activity-failed' : ''}`}>
      <summary>
        <Icon name={item.type === 'fileChange' ? 'code' : 'terminal'} size={16} />
        <span className="activity-description">
          <span className="activity-label">{activityLabels[item.type] ?? item.type}</span>
          {item.command && <code className="command-summary">{item.command}</code>}
        </span>
        <span className="activity-status">
          {item.status ? (activityStatusLabels[item.status] ?? item.status) : ''}
        </span>
        <Icon name="chevron" size={14} />
      </summary>
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
    </details>
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

function Item({ item }: { item: ItemView }) {
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    const user = item.type === 'userMessage';
    return (
      <article className={user ? 'message user-message' : 'message assistant-message'}>
        <div className="message-avatar">{user ? '你' : <Icon name="code" size={17} />}</div>
        <div className="message-content">
          <div className="message-author">{user ? '你' : 'Codex'}</div>
          {user ? <p className="user-text">{item.text}</p> : <TextContent text={item.text ?? ''} />}
          {item.error && <p className="inline-error">{item.error}</p>}
        </div>
      </article>
    );
  }
  return <Activity item={item} />;
}

export function Conversation({
  thread,
  offline,
  projectName,
}: {
  thread?: ThreadView;
  offline: boolean;
  projectName?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showBottom, setShowBottom] = useState(false);
  const previousThread = useRef(thread?.id);
  useEffect(() => {
    if (previousThread.current !== thread?.id) {
      previousThread.current = thread?.id;
      stickToBottom.current = true;
      setShowBottom(false);
    }
    if (stickToBottom.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread]);
  return (
    <div className="conversation-area">
      <div
        className="conversation-scroll"
        ref={containerRef}
        onScroll={() => {
          const box = containerRef.current;
          if (!box) return;
          stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
          setShowBottom(!stickToBottom.current);
        }}
      >
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
              <p className="eyebrow">你的本地开发工作空间</p>
              <h1>从一个想法，开始工作。</h1>
              <p>
                选择会话继续，或在{projectName ? `「${projectName}」` : '项目'}中新建会话。
                <br />
                Codex 在你的电脑上执行，你在这里掌握进展。
              </p>
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
                {turn.items.map((item) => (
                  <Item key={item.id} item={item} />
                ))}
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
                {turn.error && <div className="error-banner">{turn.error}</div>}
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
