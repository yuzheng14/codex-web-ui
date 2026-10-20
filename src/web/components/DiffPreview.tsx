import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { readableError } from '../lib/utils';
import { ChevronDown, ChevronUp, FileCode2, WrapText } from 'lucide-react';
import type { FileChange } from '../../shared/types';
import { diffCollapseReason, diffKindLabels, parseDiff, type DiffFile } from '../lib/diff';
import { highlightDiffHunks } from '../lib/diff-inline';
import { FilePreviewPanel } from './FilePreviewPanel';
import { Button } from './ui/button';

export interface DiffPreviewTarget {
  id: string;
  scope: string;
  source: 'turn' | 'item';
  selectedPath?: string;
  cursor?: string;
}
interface DiffSnapshot extends DiffPreviewTarget {
  text?: string;
  changes?: FileChange[];
  truncated?: boolean;
}
function Stats({ file }: { file: DiffFile }) {
  return (
    <span
      className="diff-stats"
      aria-label={`新增 ${file.additions} 行，删除 ${file.deletions} 行`}
    >
      <span>+{file.additions}</span>
      <span>−{file.deletions}</span>
    </span>
  );
}

export function DiffPreview({
  target,
  threadId,
  onClose,
}: {
  target: DiffPreviewTarget;
  threadId: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<DiffSnapshot>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      setError('读取变更超时，请重试。');
    }, 35_000);
    setLoaded(undefined);
    setError(undefined);
    const read = target.cursor
      ? api.threadHistory(threadId, target.cursor, controller.signal)
      : api.thread(threadId, controller.signal);
    void read
      .then((thread) => {
        if (controller.signal.aborted) return;
        if (target.source === 'turn') {
          const turn = thread.turns.find((entry) => entry.id === target.id);
          if (!turn) throw new Error('此轮变更已不在可读取的会话历史中。');
          setLoaded({
            ...target,
            text: turn.diff,
            changes:
              turn.diff === undefined
                ? turn.items.flatMap((entry) => entry.changes ?? [])
                : undefined,
            truncated:
              thread.historyTruncated ||
              turn.items.some((entry) => entry.type === 'fileChange' && entry.truncated),
          });
        } else {
          const item = thread.turns
            .flatMap((entry) => entry.items)
            .find((entry) => entry.id === target.id);
          if (!item) throw new Error('此工具的变更已不在可读取的会话历史中。');
          setLoaded({ ...target, changes: item.changes ?? [], truncated: item.truncated });
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(readableError(failure));
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [target, threadId, attempt]);
  return (
    <FilePreviewPanel
      label="代码变更预览"
      title="代码变更"
      subtitle={`${target.scope} · 只读`}
      icon={<FileCode2 size={19} className="file-preview-icon" aria-hidden="true" />}
      onClose={onClose}
    >
      <p className="diff-scope">
        Codex 提供的变更快照，仅包含此范围内的补丁，不代表工作区全部未提交变更。
      </p>
      {error ? (
        <div className="diff-empty" role="alert">
          <h3>无法读取变更</h3>
          <p>{error}</p>
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
            重新加载
          </Button>
        </div>
      ) : loaded ? (
        <DiffContent key={attempt} target={loaded} />
      ) : (
        <p className="file-preview-loading diff-loading" role="status">
          正在读取变更…
        </p>
      )}
    </FilePreviewPanel>
  );
}

function DiffContent({ target }: { target: DiffSnapshot }) {
  const files = useMemo(
    () =>
      target.changes
        ? target.changes.flatMap((change) => parseDiff(change.diff, change))
        : parseDiff(target.text ?? ''),
    [target],
  );
  const [wrap, setWrap] = useState(false);
  return (
    <>
      {target.truncated && (
        <p className="diff-warning" role="status">
          补丁已被截断，以下仅展示收到的部分内容。
        </p>
      )}
      {files.length ? (
        <>
          <div className="diff-list-toolbar">
            <span>此快照共 {files.length} 个文件</span>
            <Button variant="ghost" size="sm" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
              <WrapText size={15} />
              自动换行
            </Button>
          </div>
          <div className="diff-files" tabIndex={0} aria-label="变更文件列表">
            {files.map((file, index) => (
              <DiffFilePreview
                key={index}
                file={file}
                wrap={wrap}
                reveal={
                  target.selectedPath !== undefined &&
                  (file.path === target.selectedPath || file.oldPath === target.selectedPath)
                }
              />
            ))}
          </div>
        </>
      ) : (
        <div className="diff-empty" role="status">
          <FileCode2 size={28} />
          <h3>暂无文件变更</h3>
          <p>此范围内尚未收到可预览的补丁。</p>
        </div>
      )}
      <footer className="file-preview-path">{target.scope}</footer>
    </>
  );
}

/** Each file owns its disclosure; expensive highlighting and code rows mount only on expansion. */
function DiffFilePreview({
  file,
  wrap,
  reveal,
}: {
  file: DiffFile;
  wrap: boolean;
  reveal: boolean;
}) {
  const reason = useMemo(() => diffCollapseReason(file), [file]);
  const [expanded, setExpanded] = useState(() => reveal || !reason);
  const section = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const restorePosition = useRef<number | undefined>(undefined);
  const contentId = useId();
  useEffect(() => {
    if (reveal) section.current?.scrollIntoView({ block: 'start' });
  }, [reveal]);
  useLayoutEffect(() => {
    const top = restorePosition.current;
    const element = section.current;
    const scroller = element?.closest('.diff-files');
    if (top !== undefined && element && scroller) {
      scroller.scrollTop += element.getBoundingClientRect().top - top;
      toggle.current?.focus({ preventScroll: true });
      restorePosition.current = undefined;
    }
  }, [expanded]);
  function collapse() {
    const element = section.current;
    const scroller = element?.closest('.diff-files');
    if (element && scroller) {
      // A bottom collapse returns to this file; a visible header stays in the same place.
      restorePosition.current = Math.max(
        element.getBoundingClientRect().top,
        scroller.getBoundingClientRect().top,
      );
    }
    setExpanded(false);
  }
  return (
    <section ref={section} className="diff-file" aria-label={file.path}>
      <div className="diff-file-heading">
        <h3>
          <code>{file.path}</code>
        </h3>
        <span className={`diff-kind diff-kind-${file.kind}`}>{diffKindLabels[file.kind]}</span>
        <Stats file={file} />
        <Button
          ref={toggle}
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => (expanded ? collapse() : setExpanded(true))}
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          {expanded ? '收起变更' : '展开变更'}
        </Button>
      </div>
      {file.kind === 'renamed' && file.oldPath && (
        <p className="diff-rename">原路径：{file.oldPath}</p>
      )}
      {file.incomplete && (
        <p className="diff-warning" role="status">
          补丁不完整或格式有误，行号与统计仅对应已收到的内容。
        </p>
      )}
      {!expanded && (
        <p className="diff-collapsed">{reason ?? '变更已手动收起。'} 可通过「展开变更」查看。</p>
      )}
      <div id={contentId} hidden={!expanded}>
        {expanded && <DiffFileBody file={file} wrap={wrap} />}
        {expanded && reason && (
          <Button className="diff-collapse-bottom" variant="ghost" size="sm" onClick={collapse}>
            <ChevronUp size={15} />
            收起变更
          </Button>
        )}
      </div>
    </section>
  );
}

function DiffFileBody({ file, wrap }: { file: DiffFile; wrap: boolean }) {
  const [hunkIndex, setHunkIndex] = useState(0);
  const hunks = useRef<(HTMLElement | null)[]>([]);
  const highlightedHunks = useMemo(() => highlightDiffHunks(file.hunks), [file]);
  const failed =
    !file.binary &&
    !file.hunks.length &&
    file.metadata.some(
      (line) =>
        !/^(old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to )/.test(
          line,
        ),
    );
  function jump(index: number) {
    setHunkIndex(index);
    hunks.current[index]?.scrollIntoView({ block: 'start' });
  }
  return (
    <>
      {file.hunks.length > 1 && (
        <div className="diff-controls" role="group" aria-label="变更区块导航">
          <Button
            variant="ghost"
            size="icon"
            aria-label="上一个变更区块"
            disabled={hunkIndex === 0}
            onClick={() => jump(hunkIndex - 1)}
          >
            <ChevronUp size={16} />
          </Button>
          <span>
            {hunkIndex + 1} / {file.hunks.length} 个区块
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="下一个变更区块"
            disabled={hunkIndex >= file.hunks.length - 1}
            onClick={() => jump(hunkIndex + 1)}
          >
            <ChevronDown size={16} />
          </Button>
        </div>
      )}
      <div
        className={`diff-content${wrap ? ' diff-wrap' : ''}`}
        tabIndex={0}
        aria-label={`${file.path} 的变更内容`}
      >
        {file.binary ? (
          <div className="diff-empty">
            <FileCode2 size={28} />
            <h3>二进制文件已变更</h3>
            <p>此文件无法逐行预览。</p>
          </div>
        ) : failed ? (
          <div className="diff-empty" role="alert">
            <h3>无法读取变更内容</h3>
            <p>收到的内容不是可识别的 unified diff。请等待 Codex 更新补丁，或重新打开预览。</p>
          </div>
        ) : file.hunks.length ? (
          <table className="diff-table" aria-label={`${file.path} 的行变更`}>
            <thead>
              <tr>
                <th scope="col">原行</th>
                <th scope="col">新行</th>
                <th scope="col" aria-label="变更类型" />
                <th scope="col">代码内容</th>
              </tr>
            </thead>
            {highlightedHunks.map((hunk, index) => (
              <tbody
                key={index}
                ref={(element) => {
                  hunks.current[index] = element;
                }}
              >
                <tr className="diff-hunk">
                  <td colSpan={4}>
                    <span>区块 {index + 1}</span> {hunk.header}
                  </td>
                </tr>
                {hunk.lines.map((line, row) => (
                  <tr key={row} className={`diff-line diff-${line.kind}`}>
                    <td className="diff-line-number">{line.oldLine}</td>
                    <td className="diff-line-number">{line.newLine}</td>
                    <td
                      className="diff-marker"
                      aria-label={
                        { added: '新增', removed: '删除', context: '上下文', note: '提示' }[
                          line.kind
                        ]
                      }
                    >
                      {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
                    </td>
                    <td className="diff-code">
                      <code>
                        {line.segments
                          ? line.segments.map((segment, index) =>
                              segment.changed ? (
                                <mark className="diff-inline-change" key={index}>
                                  {segment.text}
                                </mark>
                              ) : (
                                segment.text
                              ),
                            )
                          : line.text || ' '}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        ) : (
          <div className="diff-empty">
            <h3>没有逐行内容变更</h3>
            <p>此补丁仅包含文件属性、路径或空文件变更，没有可展示的代码行。</p>
          </div>
        )}
      </div>
    </>
  );
}
