import { useEffect, useRef, useState } from 'react';
import type { ProjectClone } from '../../shared/types';
import { api, HttpError } from '../lib/api';
import { readableError } from '../lib/utils';
import { Button } from './ui/button';

const storageKey = 'covro.project-clone';
function savedClone(): string | undefined {
  try {
    return sessionStorage.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
}
function remember(id?: string) {
  try {
    if (id) sessionStorage.setItem(storageKey, id);
    else sessionStorage.removeItem(storageKey);
  } catch {
    /* Cloning still works without browser storage. */
  }
}
const running = (job?: ProjectClone) => job?.status === 'cloning' || job?.status === 'cancelling';

export function CloneProjectForm(props: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onImported: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [repository, setRepository] = useState('');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [jobId, setJobId] = useState(savedClone);
  const [job, setJob] = useState<ProjectClone>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const busy = sending || Boolean(jobId && !job) || running(job);
  const { onBusyChange } = props;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.projectClone(jobId);
        if (stopped) return;
        setJob(next);
        setPath(next.path);
        setName(next.name ?? '');
        setError(undefined);
        if (!running(next)) return;
      } catch (problem) {
        if (stopped) return;
        setError(readableError(problem));
        if (problem instanceof HttpError && problem.status === 404) {
          setJobId(undefined);
          remember();
          return;
        }
      }
      timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId]);

  async function start() {
    if (busy || props.disabled || submitting.current) return;
    submitting.current = true;
    setSending(true);
    setError(undefined);
    const id = crypto.randomUUID();
    remember(id);
    try {
      const next = await api.cloneProject({
        clientOperationId: id,
        repository: repository.trim(),
        path: path.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setJob(next);
      setJobId(id);
    } catch (problem) {
      setError(readableError(problem));
      if (problem instanceof HttpError && problem.status < 500) remember();
      else {
        // A lost POST response must be reconciled by its original identity.
        setJob(undefined);
        setJobId(id);
      }
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }

  async function action(kind: 'cancel' | 'register' | 'open') {
    if (!job || submitting.current) return;
    submitting.current = true;
    setSending(true);
    setError(undefined);
    try {
      if (kind === 'open' && job.project) {
        await props.onImported(job.project.id);
        remember();
        props.onClose();
      } else {
        setJob(
          await (kind === 'cancel'
            ? api.cancelProjectClone(job.id)
            : api.registerProjectClone(job.id)),
        );
      }
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }

  const terminal = job && !running(job);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <p id="project-dialog-description">
        从 Git 仓库克隆到运行 Covro 的服务器，完成后自动添加项目。
      </p>
      {!job && !jobId && (
        <>
          <label className="project-field">
            <span>Git 仓库地址</span>
            <input
              autoFocus
              required
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://github.com/owner/repository.git"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              disabled={props.disabled || sending}
              aria-describedby="clone-auth-help"
              aria-label="Git 仓库地址"
            />
            <small id="clone-auth-help">
              支持 HTTPS 和 SSH（如 git@github.com:owner/repo.git）。使用服务器已有的 Git
              认证，请勿在地址中填写密码或令牌。
            </small>
          </label>
          <label className="project-field">
            <span>服务器目标目录</span>
            <input
              required
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
              placeholder="/home/you/code/my-project"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              disabled={props.disabled || sending}
              aria-describedby="clone-path-help"
              aria-label="服务器目标目录"
            />
            <small id="clone-path-help">
              填写服务器上的绝对路径。父目录须已存在且可写；目标目录须不存在或为空，不会覆盖已有文件。
            </small>
          </label>
          <label className="project-field">
            <span>项目名称（可选）</span>
            <input
              maxLength={100}
              placeholder="默认使用目录名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={props.disabled || sending}
            />
          </label>
        </>
      )}
      {(job || jobId) && (
        <div className="project-clone-status" role="status" aria-live="polite">
          <strong>
            {job?.progress ?? '正在核对克隆状态…'}
            {job?.percent !== undefined ? ` ${job.percent}%` : ''}
          </strong>
          {running(job) && <progress aria-label="克隆进度" max={100} value={job?.percent} />}
          <code>{job?.path ?? path}</code>
          {running(job) && <small>关闭或刷新页面不会取消克隆。需要停止时请点击“取消克隆”。</small>}
        </div>
      )}
      {job?.error && (
        <p className="inline-error project-dialog-error" role="alert">
          {job.error}
        </p>
      )}
      {error && (
        <p className="inline-error project-dialog-error" role="alert">
          {error}
        </p>
      )}
      {props.disabled && <p className="subtle">登录已过期，请重新登录后管理项目。</p>}
      <div className="project-dialog-actions">
        {running(job) ? (
          <Button
            variant="secondary"
            disabled={props.disabled || sending || job?.status === 'cancelling'}
            onClick={() => void action('cancel')}
          >
            {job?.status === 'cancelling' ? '正在取消…' : '取消克隆'}
          </Button>
        ) : (
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            关闭
          </Button>
        )}
        {job?.status === 'completed' ? (
          <Button disabled={props.disabled || sending} onClick={() => void action('open')}>
            打开项目
          </Button>
        ) : job?.status === 'registration-failed' ? (
          <Button disabled={props.disabled || sending} onClick={() => void action('register')}>
            重试添加项目
          </Button>
        ) : terminal ? (
          <Button
            disabled={props.disabled || sending}
            onClick={(event) => {
              event.preventDefault();
              remember();
              setJobId(undefined);
              setJob(undefined);
              setError(undefined);
            }}
          >
            使用空目录重试
          </Button>
        ) : (
          !jobId && (
            <Button
              type="submit"
              disabled={props.disabled || sending || !repository.trim() || !path.trim()}
            >
              {sending ? '正在提交…' : '克隆并添加项目'}
            </Button>
          )
        )}
      </div>
    </form>
  );
}
