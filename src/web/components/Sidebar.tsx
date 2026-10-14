import type { Project, ThreadView } from '../../shared/types';
import { formatTime, cn } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive } from './Status';

interface Props {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  threads: ThreadView[];
  selectedId?: string;
  onThread: (id: string) => void;
  nextCursor: string | null;
  loading: boolean;
  onMore: () => void;
  onRefresh: () => void;
  onCreate: () => void;
  creating: boolean;
  canCreate: boolean;
  open: boolean;
  onClose: () => void;
}
export function Sidebar(props: Props) {
  const project = props.projects.find((entry) => entry.id === props.projectId);
  return (
    <>
      {props.open && (
        <button className="sidebar-backdrop" aria-label="关闭会话导航" onClick={props.onClose} />
      )}
      <aside className={cn('sidebar', props.open && 'sidebar-open')} aria-label="项目与会话">
        <div className="brand">
          <div className="brand-mark">
            <Icon name="code" size={21} />
          </div>
          <div>
            Codex <span>workspace</span>
          </div>
          <Button
            className="mobile-only"
            variant="ghost"
            size="icon"
            aria-label="关闭导航"
            onClick={props.onClose}
          >
            <Icon name="close" />
          </Button>
        </div>
        <div className="project-picker">
          <label className="eyebrow" htmlFor="project">
            当前项目
          </label>
          <div className="select-wrapper">
            <Icon name="folder" />
            <select
              id="project"
              value={props.projectId}
              onChange={(event) => props.onProject(event.target.value)}
            >
              <option value="" disabled>
                选择项目
              </option>
              {props.projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {entry.available ? '' : ' · 不可用'}
                </option>
              ))}
            </select>
          </div>
          {project && (
            <p className="project-path" title={project.rootPath}>
              {project.rootPath}
            </p>
          )}
          {project && !project.available && (
            <p className="inline-error">{project.error ?? '项目目录不可用'}</p>
          )}
        </div>
        <Button
          className="new-thread"
          variant="secondary"
          onClick={props.onCreate}
          disabled={!props.canCreate || props.creating}
        >
          <Icon name="plus" />
          {props.creating ? '正在创建…' : '新建会话'}
        </Button>
        <div className="section-label">
          <span>最近会话</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新会话列表"
            onClick={props.onRefresh}
            disabled={props.loading}
          >
            <Icon name="refresh" size={14} />
          </Button>
        </div>
        <nav className="thread-list" aria-label="会话历史">
          {props.threads.map((entry) => (
            <button
              key={entry.id}
              className={cn('thread-link', entry.id === props.selectedId && 'thread-selected')}
              onClick={() => {
                props.onThread(entry.id);
                props.onClose();
              }}
              aria-current={entry.id === props.selectedId ? 'page' : undefined}
            >
              <Icon name={entry.forkedFromId ? 'fork' : 'chat'} size={16} />
              <span className="thread-link-content">
                <span className="thread-title">{entry.title || '未命名会话'}</span>
                <span className="thread-meta">
                  {entry.source === 'cli'
                    ? 'CLI'
                    : entry.source === 'appServer'
                      ? 'Web'
                      : entry.source}
                  {entry.forkedFromId ? ' · Fork' : ''}{' '}
                  {entry.updatedAt ? `· ${formatTime(entry.updatedAt)}` : ''}
                </span>
              </span>
              {isActive(entry.status) && <span className="activity-dot" aria-label="正在执行" />}
            </button>
          ))}
          {!props.loading && props.threads.length === 0 && (
            <p className="sidebar-empty">暂无会话。创建一个，开始工作。</p>
          )}
          {props.loading && (
            <p className="sidebar-empty" role="status">
              正在读取会话…
            </p>
          )}
          {props.nextCursor && (
            <Button
              variant="ghost"
              className="load-more"
              disabled={props.loading}
              onClick={props.onMore}
            >
              加载更多会话
            </Button>
          )}
        </nav>
        <div className="sidebar-footer">
          <span className="privacy-mark">本机执行</span>
          <p>代码与凭据保留在你的电脑上</p>
        </div>
      </aside>
    </>
  );
}
