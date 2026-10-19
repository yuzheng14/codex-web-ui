import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../shared/types';
import { shellActive, type ShellCommand } from '../../shared/shell';
import type { useShell } from '../hooks/useShell';
import { Button } from './ui/button';
import { Icon } from './Icon';
import './shell-panel.css';

const statusText: Record<ShellCommand['status'], string> = {
  running: '执行中',
  stopping: '正在中断',
  completed: '已完成',
  failed: '执行失败',
  interrupted: '已中断',
  unknown: '结果未知',
};
export function ShellPanel({
  open,
  project,
  shell,
  canExecute,
  collapsed,
  onCollapse,
  onClose,
}: {
  open: boolean;
  project?: Project;
  shell: ReturnType<typeof useShell>;
  canExecute: boolean;
  collapsed: boolean;
  onCollapse: () => void;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const output = useRef<HTMLPreElement>(null);
  const projectId = project?.id ?? '';
  const runs = shell.commands.filter((run) => run.projectId === projectId);
  const run = runs.find((entry) => entry.id === selected[projectId]) ?? runs[0];
  const active = runs.find(shellActive);
  const elsewhere = shell.commands.filter(
    (entry) => entry.projectId !== projectId && shellActive(entry),
  );
  const draft = drafts[projectId] ?? '';
  const changeDraft = (value: string) =>
    setDrafts((current) => ({ ...current, [projectId]: value }));
  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [run?.revision, run?.id, collapsed, open]);
  if (!open) return null;
  return (
    <section
      className={`shell-panel${collapsed ? ' shell-collapsed' : ''}`}
      aria-label="Shell 面板"
    >
      <header className="shell-header">
        <div className="shell-heading">
          <Icon name="terminal" size={17} />
          <strong>Shell</strong>
          <span>{project?.name ?? '请选择项目'}</span>
          {active && <span className="shell-running">{statusText[active.status]}</span>}
        </div>
        <div className="shell-actions">
          <Button
            variant="ghost"
            size="icon"
            aria-label={collapsed ? '展开 Shell' : '收起 Shell'}
            aria-expanded={!collapsed}
            aria-controls="shell-body"
            onClick={onCollapse}
          >
            <Icon name={collapsed ? 'terminal' : 'down'} size={15} />
          </Button>
          <Button variant="ghost" size="icon" aria-label="关闭 Shell 面板" onClick={onClose}>
            <Icon name="close" size={15} />
          </Button>
        </div>
      </header>
      {collapsed ? (
        <p className="shell-collapsed-note">
          收起不会停止命令{elsewhere.length ? ` · 另有 ${elsewhere.length} 个项目正在执行` : ''}
        </p>
      ) : (
        <div id="shell-body" className="shell-body">
          <div className="shell-location">
            <span>工作目录</span>
            <code>{project?.canonicalRoot ?? '—'}</code>
          </div>
          <p className="shell-help">
            命令执行面板 · 使用 Codex
            服务端配置的沙箱，独立于会话权限。每次从项目根目录启动，不支持交互输入。收起、关闭或切换项目均不会停止命令。
          </p>
          {elsewhere.length > 0 && (
            <p className="shell-background" role="status">
              其他项目仍在执行：{elsewhere.map((entry) => entry.projectName).join('、')}
              。切回对应项目可查看或中断。
            </p>
          )}
          {!shell.connected && (
            <p className="shell-warning" role="status">
              Shell
              连接已断开，正在重连。已收到的输出已保留，运行状态待确认；断开浏览器不会停止命令。
            </p>
          )}
          {shell.error && (
            <p className="shell-warning" role="alert">
              {shell.error}
            </p>
          )}
          {shell.pending && (
            <div className="shell-warning" role="status">
              正在核对命令的提交结果：<code>{shell.pending.command}</code>{' '}
              <Button
                variant="secondary"
                size="sm"
                disabled={!shell.connected || shell.submitting}
                onClick={() => void shell.retry()}
              >
                核对并重试原提交
              </Button>
            </div>
          )}
          <div className="shell-result">
            <div className="shell-result-toolbar">
              <label>
                近期命令
                <select
                  aria-label="近期 Shell 命令"
                  value={run?.id ?? ''}
                  onChange={(event) =>
                    setSelected((current) => ({ ...current, [projectId]: event.target.value }))
                  }
                >
                  {!runs.length && <option value="">尚未执行</option>}
                  {runs.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {statusText[entry.status]} · {entry.command.slice(0, 70)}
                    </option>
                  ))}
                </select>
              </label>
              {run && (
                <Button variant="ghost" size="sm" onClick={() => changeDraft(run.command)}>
                  复用命令
                </Button>
              )}
            </div>
            {run ? (
              <>
                <div className="shell-command-line">
                  <span aria-hidden="true">$</span>
                  <code>{run.command}</code>
                </div>
                <pre ref={output} className="shell-output" aria-label="Shell 输出" tabIndex={0}>
                  {run.output.length ? (
                    run.output.map((chunk, index) => (
                      <span
                        key={index}
                        className={chunk.stream === 'stderr' ? 'shell-stderr' : undefined}
                      >
                        {chunk.text}
                      </span>
                    ))
                  ) : (
                    <span className="shell-output-empty">
                      {shellActive(run) ? '等待输出…' : '无输出'}
                    </span>
                  )}
                </pre>
                <div className={`shell-result-status shell-status-${run.status}`} role="status">
                  <span>{statusText[run.status]}</span>
                  {run.exitCode !== undefined && <span>退出码 {run.exitCode}</span>}
                  {run.truncated && <span>输出已截断（最多 64 KiB）</span>}
                </div>
                {run.error && (
                  <p className="shell-warning" role="alert">
                    {run.error}
                  </p>
                )}
              </>
            ) : (
              <div className="shell-empty">
                <Icon name="terminal" size={25} />
                <p>在项目目录中运行命令，实时查看输出。</p>
                <span>例如 git status、pwd 或运行项目测试</span>
              </div>
            )}
          </div>
          <form
            className="shell-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !project ||
                !canExecute ||
                !shell.connected ||
                active ||
                shell.pending ||
                !draft.trim()
              )
                return;
              const target = project.id;
              void shell.execute(target, draft).then((accepted) => {
                if (accepted) {
                  setDrafts((current) =>
                    current[target] === draft ? { ...current, [target]: '' } : current,
                  );
                  setSelected((current) => ({ ...current, [target]: '' }));
                }
              });
            }}
          >
            <label className="sr-only" htmlFor="shell-command-input">
              Shell 命令
            </label>
            <textarea
              id="shell-command-input"
              rows={2}
              maxLength={8192}
              value={draft}
              onChange={(event) => changeDraft(event.target.value)}
              placeholder="输入命令…"
              disabled={!project?.available}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey))
                  event.currentTarget.form?.requestSubmit();
              }}
            />
            <div className="shell-submit-row">
              <span>
                {active ? '命令在服务端运行，可随时中断' : 'Ctrl / ⌘ + Enter 执行 · 最长 10 分钟'}
              </span>
              {active ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={
                    !shell.connected || Boolean(shell.interrupting) || active.status === 'stopping'
                  }
                  onClick={() => void shell.interrupt(active.id)}
                >
                  <Icon name="stop" size={13} />
                  {active.status === 'stopping' || shell.interrupting === active.id
                    ? '正在中断…'
                    : '中断命令'}
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    !canExecute ||
                    !shell.connected ||
                    !draft.trim() ||
                    Boolean(shell.pending) ||
                    shell.submitting
                  }
                >
                  <Icon name="terminal" size={14} />
                  {shell.submitting ? '正在提交…' : '执行命令'}
                </Button>
              )}
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
