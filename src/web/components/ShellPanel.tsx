import { displayMessage } from '../i18n/messages';
import { t, formatList } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../shared/types';
import { shellActive, type ShellCommand } from '../../shared/shell';
import type { useShell } from '../hooks/useShell';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Icon } from './Icon';
import './shell-panel.css';

const statusText: Record<ShellCommand['status'], string> = {
  get running() {
    return t('common:running');
  },
  get stopping() {
    return t('shell:interrupting');
  },
  get completed() {
    return t('common:completed');
  },
  get failed() {
    return t('common:execution_failed');
  },
  get interrupted() {
    return t('common:interrupted');
  },
  get unknown() {
    return t('shell:result_unknown');
  },
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
      aria-label={t('shell:shell_panel')}
    >
      <header className="shell-header">
        <div className="shell-heading">
          <Icon name="terminal" size={17} />
          <strong>Shell</strong>
          <span>{project?.name ?? t('shell:select_a_project')}</span>
          {active && <span className="shell-running">{statusText[active.status]}</span>}
        </div>
        <div className="shell-actions">
          <Button
            variant="ghost"
            size="icon"
            aria-label={collapsed ? t('shell:expand_shell') : t('shell:collapse_shell')}
            aria-expanded={!collapsed}
            aria-controls="shell-body"
            onClick={onCollapse}
          >
            <Icon name={collapsed ? 'terminal' : 'down'} size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('shell:close_shell_panel')}
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </Button>
        </div>
      </header>
      {collapsed ? (
        <p className="shell-collapsed-note">
          {t('shell:collapsing_does_not_stop_commands', {
            v0: elsewhere.length
              ? t('shell:running_in_other_projects', {
                  count: elsewhere.length,
                  v0: elsewhere.length,
                })
              : '',
          })}
        </p>
      ) : (
        <div id="shell-body" className="shell-body">
          <div className="shell-location">
            <span>{t('common:working_directory')}</span>
            <code>{project?.canonicalRoot ?? '—'}</code>
          </div>
          <p className="shell-help">
            {t('shell:commands_use_the_codex_server_sandbox_independently_of')}
          </p>
          {elsewhere.length > 0 && (
            <p className="shell-background" role="status">
              {t('shell:still_running_in_other_projects_switch_to_view', {
                v0: formatList(elsewhere.map((entry) => entry.projectName)),
              })}
            </p>
          )}
          {!shell.connected && (
            <p className="shell-warning" role="status">
              {t('shell:shell_disconnected_reconnecting_received_output_is_preserved_and')}
            </p>
          )}
          {shell.error && (
            <p className="shell-warning" role="alert">
              {displayMessage(shell.error)}
            </p>
          )}
          {shell.pending && (
            <div className="shell-warning" role="status">
              {t('shell:checking_command_submission')}
              <code>{shell.pending.command}</code>{' '}
              <Button
                variant="secondary"
                size="sm"
                disabled={!shell.connected || shell.submitting}
                onClick={() => void shell.retry()}
              >
                {t('shell:check_and_retry_original_submission')}
              </Button>
            </div>
          )}
          <div className="shell-result">
            <div className="shell-result-toolbar">
              <label>
                {t('shell:recent_commands')}
                <Select
                  value={run?.id ?? ''}
                  disabled={!runs.length}
                  onValueChange={(value) =>
                    setSelected((current) => ({ ...current, [projectId]: value }))
                  }
                >
                  <SelectTrigger aria-label={t('shell:recent_shell_commands')}>
                    <SelectValue placeholder={t('shell:not_run_yet')} />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {runs.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {statusText[entry.status]} · {entry.command.slice(0, 70)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {run && (
                <Button variant="ghost" size="sm" onClick={() => changeDraft(run.command)}>
                  {t('shell:reuse_command')}
                </Button>
              )}
            </div>
            {run ? (
              <>
                <div className="shell-command-line">
                  <span aria-hidden="true">$</span>
                  <code>{run.command}</code>
                </div>
                <pre
                  ref={output}
                  className="shell-output"
                  aria-label={t('shell:shell_output')}
                  tabIndex={0}
                >
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
                      {shellActive(run) ? t('shell:waiting_for_output') : t('shell:no_output')}
                    </span>
                  )}
                </pre>
                <div className={`shell-result-status shell-status-${run.status}`} role="status">
                  <span>{statusText[run.status]}</span>
                  {run.exitCode !== undefined && (
                    <span>{t('shell:exit_code', { v0: run.exitCode })}</span>
                  )}
                  {run.truncated && <span>{t('shell:output_truncated_64_kib_maximum')}</span>}
                </div>
                {run.error && (
                  <p className="shell-warning" role="alert">
                    {displayMessage(run.error)}
                  </p>
                )}
              </>
            ) : (
              <div className="shell-empty">
                <Icon name="terminal" size={25} />
                <p>{t('shell:run_commands_in_the_project_directory_and_view')}</p>
                <span>{t('shell:for_example_git_status_pwd_or_project_tests')}</span>
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
              {t('shell:shell_command')}
            </label>
            <textarea
              id="shell-command-input"
              rows={2}
              maxLength={8192}
              value={draft}
              onChange={(event) => changeDraft(event.target.value)}
              placeholder={t('shell:enter_a_command')}
              disabled={!project?.available}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey))
                  event.currentTarget.form?.requestSubmit();
              }}
            />
            <div className="shell-submit-row">
              <span>
                {active
                  ? t('shell:commands_run_on_the_server_and_can_be')
                  : t('shell:ctrl_enter_to_run_10_minute_limit')}
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
                    ? t('shell:interrupting_2')
                    : t('shell:interrupt_command')}
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
                  {shell.submitting ? t('common:submitting') : t('common:run_command')}
                </Button>
              )}
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
