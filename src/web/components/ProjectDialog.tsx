import { t } from '../i18n';
import { displayMessage } from '../i18n/messages';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../shared/types';
import { readableError } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { CloneProjectForm } from './CloneProjectForm';

interface Props {
  project?: Project;
  disabled: boolean;
  onAdd: (input: { path: string; name?: string }) => Promise<void>;
  onImported: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
}

export function ProjectDialog(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [path, setPath] = useState('');
  const [name, setName] = useState(props.project?.name ?? '');
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cloneMode, setCloneMode] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = props.disabled || busy;
  const title = removing ? '移除项目' : props.project ? '管理项目' : '添加服务器项目';

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  async function submit() {
    if (disabled || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (props.project) {
        if (removing) await props.onRemove(props.project.id);
        else await props.onRename(props.project.id, name.trim());
      } else {
        await props.onAdd({ path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
      }
      props.onClose();
    } catch (problem) {
      setError(readableError(problem));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="project-dialog"
      aria-labelledby="project-dialog-title"
      aria-describedby="project-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) props.onClose();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <Icon name="folder" size={20} />
          <h2 id="project-dialog-title">{title}</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭项目管理"
          disabled={busy}
          onClick={props.onClose}
        >
          <Icon name="close" size={17} />
        </Button>
      </div>
      {!props.project && (
        <div className="project-import-modes" role="group" aria-label="项目来源">
          <Button
            variant={cloneMode ? 'ghost' : 'secondary'}
            disabled={busy}
            aria-pressed={!cloneMode}
            onClick={() => setCloneMode(false)}
          >
            已有目录
          </Button>
          <Button
            variant={cloneMode ? 'secondary' : 'ghost'}
            disabled={busy}
            aria-pressed={cloneMode}
            onClick={() => setCloneMode(true)}
          >
            克隆 Git 仓库
          </Button>
        </div>
      )}
      {cloneMode ? (
        <CloneProjectForm
          disabled={props.disabled}
          onBusyChange={setBusy}
          onImported={props.onImported}
          onClose={props.onClose}
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {removing ? (
            <>
              <p id="project-dialog-description">确定从工作空间移除「{props.project?.name}」？</p>
              <div className="project-removal-note">
                <p>只移除项目列表中的记录，服务器上的文件和会话历史都会保留。</p>
                <p>
                  之后重新添加同一目录，即可继续访问原有会话。进行中的任务或未确认的操作需要先处理完成。
                </p>
              </div>
            </>
          ) : (
            <>
              <p id="project-dialog-description">
                {props.project
                  ? '为项目设置便于识别的名称，或从工作空间移除项目。'
                  : '添加运行 Codex Web UI 的服务器上已有的目录。添加后即可查看历史会话并开始工作。'}
              </p>
              {props.project ? (
                <div className="project-directory">
                  <span>服务器目录</span>
                  <code>{props.project.rootPath}</code>
                </div>
              ) : (
                <label className="project-field">
                  <span>服务器目录</span>
                  <input
                    autoFocus
                    required
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="/home/you/code/my-project"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    aria-describedby="project-path-help"
                    aria-label="服务器目录"
                    disabled={disabled}
                  />
                  <small id="project-path-help">
                    填写服务器上的绝对路径，不是当前浏览器所在设备的目录。目录需要已存在，且服务有权访问。
                  </small>
                </label>
              )}
              <label className="project-field">
                <span>{props.project ? '项目名称' : '项目名称（可选）'}</span>
                <input
                  autoFocus={Boolean(props.project)}
                  required={Boolean(props.project)}
                  maxLength={100}
                  placeholder="默认使用目录名称"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={disabled}
                />
              </label>
            </>
          )}
          {error && (
            <p className="inline-error project-dialog-error" role="alert">
              {displayMessage(error)}
            </p>
          )}
          {props.disabled && <p className="subtle">登录已过期，请重新登录后管理项目。</p>}
          <div className="project-dialog-actions">
            {props.project && !removing && (
              <Button
                className="project-remove-button"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  setError(undefined);
                  setRemoving(true);
                }}
              >
                移除项目…
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (removing) {
                  setError(undefined);
                  setRemoving(false);
                } else props.onClose();
              }}
            >
              {removing ? '返回' : '取消'}
            </Button>
            <Button
              type="submit"
              variant={removing ? 'destructive' : 'default'}
              disabled={disabled || (!removing && (props.project ? !name.trim() : !path.trim()))}
            >
              {busy
                ? removing
                  ? '正在移除…'
                  : '正在保存…'
                : removing
                  ? '确认移除'
                  : props.project
                    ? '保存名称'
                    : '添加项目'}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
