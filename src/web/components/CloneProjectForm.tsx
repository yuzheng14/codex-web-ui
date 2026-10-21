import { t, formatNumber } from '../i18n';
import { displayMessage, messageDetails } from '../i18n/messages';
import { errorMessage } from '../lib/error-message';
import { cloneProgress } from '../lib/project-clone-labels';
import { useEffect, useRef, useState } from 'react';
import type { ProjectClone } from '../../shared/types';
import { api, HttpError } from '../lib/api';
import { readableError } from '../lib/utils';
import { Button } from './ui/button';
import { useProjectPath } from '../hooks/useProjectPath';
import { ProjectPathPreview } from './ProjectPathPreview';

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
  const [name, setName] = useState('');
  const [jobId, setJobId] = useState(savedClone);
  const [job, setJob] = useState<ProjectClone>();
  const path = useProjectPath(!job && !jobId, repository);
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
        path.setValue(next.path);
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
  }, [jobId, path.setValue]);

  async function start() {
    if (busy || props.disabled || submitting.current || !path.ready) return;
    submitting.current = true;
    setSending(true);
    setError(undefined);
    const id = crypto.randomUUID();
    remember(id);
    try {
      const next = await api.cloneProject({
        clientOperationId: id,
        repository: repository.trim(),
        path: path.path!,
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
      <p id="project-dialog-description">{t('sidebar:clone_intro')}</p>
      {!job && !jobId && (
        <>
          <label className="project-field">
            <span>{t('sidebar:clone_repository')}</span>
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
              aria-label={t('sidebar:clone_repository')}
            />
            <small id="clone-auth-help">{t('sidebar:clone_auth_help')}</small>
          </label>
          <label className="project-field">
            <span>{t('sidebar:clone_target')}</span>
            <input
              required
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
              placeholder="/home/you/code/my-project"
              value={path.value}
              onChange={(event) => path.setValue(event.target.value)}
              disabled={props.disabled || sending}
              aria-describedby="clone-path-help"
              aria-label={t('sidebar:clone_target')}
            />
            <small id="clone-path-help">{t('sidebar:work_dir_clone_help')}</small>
          </label>
          <ProjectPathPreview value={path} />
          <label className="project-field">
            <span>{t('sidebar:project_name_optional')}</span>
            <input
              maxLength={100}
              placeholder={t('sidebar:defaults_to_directory_name')}
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
            {job?.percent !== undefined
              ? t('sidebar:clone_progress_percent', {
                  v0: cloneProgress(job),
                  v1: formatNumber(job.percent / 100, {
                    style: 'percent',
                    maximumFractionDigits: 0,
                  }),
                })
              : job
                ? cloneProgress(job)
                : t('sidebar:clone_checking')}
          </strong>
          {running(job) && (
            <progress aria-label={t('sidebar:clone_progress')} max={100} value={job?.percent} />
          )}
          <code>{job?.path ?? path.path ?? path.value}</code>
          {running(job) && <small>{t('sidebar:clone_background_help')}</small>}
        </div>
      )}
      {job?.error && (
        <p className="inline-error project-dialog-error" role="alert">
          {displayMessage(
            errorMessage({ code: job.errorCode ?? 'CLONE_FAILED', message: job.error }),
          )}
        </p>
      )}
      {error && (
        <p className="inline-error project-dialog-error" role="alert">
          {displayMessage(error)}
        </p>
      )}
      {(job?.error || messageDetails(error)) && (
        <details className="project-clone-details">
          <summary>{t('common:technical_details')}</summary>
          <pre>{job?.error ?? messageDetails(error)}</pre>
        </details>
      )}
      {props.disabled && (
        <p className="subtle">{t('sidebar:your_login_expired_log_in_again_to_manage')}</p>
      )}
      <div className="project-dialog-actions">
        {running(job) ? (
          <Button
            variant="secondary"
            disabled={props.disabled || sending || job?.status === 'cancelling'}
            onClick={() => void action('cancel')}
          >
            {job?.status === 'cancelling'
              ? t('sidebar:clone_cancelling')
              : t('sidebar:clone_cancel')}
          </Button>
        ) : (
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            {t('common:close')}
          </Button>
        )}
        {job?.status === 'completed' ? (
          <Button disabled={props.disabled || sending} onClick={() => void action('open')}>
            {t('sidebar:clone_open')}
          </Button>
        ) : job?.status === 'registration-failed' ? (
          <Button disabled={props.disabled || sending} onClick={() => void action('register')}>
            {t('sidebar:clone_register_retry')}
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
            {t('sidebar:clone_empty_retry')}
          </Button>
        ) : (
          !jobId && (
            <Button
              type="submit"
              disabled={props.disabled || sending || !repository.trim() || !path.ready}
            >
              {sending ? t('common:submitting') : t('sidebar:clone_start')}
            </Button>
          )
        )}
      </div>
    </form>
  );
}
