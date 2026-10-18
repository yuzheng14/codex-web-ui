import { useState } from 'react';
import { ArrowUpCircle, Bell } from 'lucide-react';
import type { Project, ThreadSummary } from '../../shared/types';
import type { ProjectThreads } from '../lib/project-threads';
import { cn } from '../lib/utils';
import { ControlHint } from './ControlHint';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive } from './Status';
import { ThreadLink } from './ThreadLink';

interface Props {
  archiveView: boolean;
  onArchiveView: (archived: boolean) => void;
  onArchive: (id: string, archived: boolean) => void;
  archiveDisabledReason: (thread: ThreadSummary) => string | undefined;
  onFork: (thread: ThreadSummary) => void;
  forkDisabledReason: (thread: ThreadSummary) => string | undefined;
  forking: (id: string) => boolean;
  projects: Project[];
  projectsLoaded: boolean;
  projectId: string;
  onProject: (id: string) => void;
  projectThreads: Record<string, ProjectThreads>;
  selectedId?: string;
  isUnreadCompletion: (thread: ThreadSummary) => boolean;
  onThread: (id: string, projectId: string) => void;
  onMore: (projectId: string, cursor: string) => void;
  onRetry: (projectId: string) => void;
  onRefresh: () => void;
  onCreate: (projectId: string) => void;
  onAddProject: () => void;
  onManageProject: (project: Project) => void;
  canManageProjects: boolean;
  creating: (projectId: string) => boolean;
  canCreate: (projectId: string) => boolean;
  offline: boolean;
  open: boolean;
  onClose: () => void;
  onNotificationSettings: () => void;
  notificationStatus: string;
  onUpdates: () => void;
  appVersion?: string;
  updateAvailable: boolean;
  updating: boolean;
}

export function Sidebar(props: Props) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const groups = props.projects.flatMap((project) => {
    const state = props.projectThreads[project.id];
    const matchesProject = `${project.name} ${project.rootPath}`
      .toLocaleLowerCase()
      .includes(query);
    const threads = (state?.data ?? []).filter(
      (thread) => matchesProject || thread.title.toLocaleLowerCase().includes(query),
    );
    return matchesProject || threads.length > 0 ? [{ project, state, threads }] : [];
  });
  return (
    <>
      {props.open && (
        <button className="sidebar-backdrop" aria-label="关闭会话导航" onClick={props.onClose} />
      )}
      <aside className={cn('sidebar', props.open && 'sidebar-open')} aria-label="项目与会话">
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-mark">
              <Icon name="code" size={21} />
            </div>
            <div className="brand-name">Covro</div>
            <Button
              className="add-project"
              variant="secondary"
              size="sm"
              onClick={props.onAddProject}
              disabled={!props.canManageProjects}
            >
              <Icon name="plus" size={15} />
              添加项目
            </Button>
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
          <div className="project-search">
            <label className="sr-only" htmlFor="project-search">
              项目与会话
            </label>
            <input
              id="project-search"
              type="search"
              aria-label="搜索项目与已加载会话"
              aria-describedby="sidebar-search-summary"
              placeholder="搜索项目与已加载会话"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <span id="sidebar-search-summary" className="sr-only" role="status">
              {query ? `搜索结果 · ${groups.length} 个项目` : `全部项目 · ${props.projects.length}`}
            </span>
          </div>
          <div className="sidebar-toolbar">
            <div className="archive-switch" role="group" aria-label="会话列表范围">
              <Button
                variant={props.archiveView ? 'ghost' : 'secondary'}
                size="sm"
                aria-pressed={!props.archiveView}
                onClick={() => props.onArchiveView(false)}
              >
                会话
              </Button>
              <Button
                variant={props.archiveView ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={props.archiveView}
                onClick={() => props.onArchiveView(true)}
              >
                <Icon name="archive" size={14} />
                已归档会话
              </Button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新会话列表"
              onClick={props.onRefresh}
              disabled={props.projects.length === 0}
            >
              <Icon name="refresh" size={14} />
            </Button>
          </div>
        </div>
        <nav className="project-list" aria-label="会话历史">
          {groups.map(({ project, state, threads }) => {
            const activeCount = (state?.data ?? []).filter((entry) =>
              isActive(entry.status),
            ).length;
            return (
              <section
                key={project.id}
                className="project-group"
                aria-label={project.name}
                data-project-id={project.id}
              >
                <h2 className="project-heading">
                  <ControlHint asChild content={project.name}>
                    <button
                      className="project-link"
                      onClick={() => props.onProject(project.id)}
                      aria-current={props.projectId === project.id ? 'true' : undefined}
                    >
                      <Icon name="folder" size={16} />
                      <span>{project.name}</span>
                      {activeCount > 0 && (
                        <span
                          className="project-activity"
                          aria-label={`${activeCount} 个进行中会话`}
                        >
                          {activeCount}
                        </span>
                      )}
                    </button>
                  </ControlHint>
                  <ControlHint content={props.creating(project.id) ? '正在创建…' : '新建会话'}>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={props.creating(project.id) ? '正在创建…' : '新建会话'}
                      onClick={() => props.onCreate(project.id)}
                      disabled={!props.canCreate(project.id) || props.creating(project.id)}
                    >
                      <Icon name={props.creating(project.id) ? 'loader' : 'plus'} size={15} />
                    </Button>
                  </ControlHint>
                  <ControlHint content={'管理项目'}>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`管理项目 ${project.name}`}
                      onClick={() => props.onManageProject(project)}
                      disabled={!props.canManageProjects}
                    >
                      <Icon name="settings" size={15} />
                    </Button>
                  </ControlHint>
                </h2>
                {!project.available && (
                  <p className="inline-error project-error" role="status">
                    {project.error ?? '项目目录不可用'}
                  </p>
                )}
                <div className="thread-list">
                  {threads.map((entry) => (
                    <ThreadLink
                      key={entry.id}
                      thread={entry}
                      selected={entry.id === props.selectedId}
                      unreadCompletion={props.isUnreadCompletion(entry)}
                      offline={props.offline}
                      onArchive={() => props.onArchive(entry.id, !entry.archived)}
                      archiveDisabledReason={props.archiveDisabledReason(entry)}
                      onFork={() => props.onFork(entry)}
                      forkDisabledReason={props.forkDisabledReason(entry)}
                      forking={props.forking(entry.id)}
                      onSelect={() => {
                        props.onThread(entry.id, project.id);
                        props.onClose();
                      }}
                    />
                  ))}
                  {project.available &&
                    !state?.loading &&
                    !state?.error &&
                    threads.length === 0 && (
                      <p className="sidebar-empty">
                        {query
                          ? '已加载会话中没有匹配结果。'
                          : props.archiveView
                            ? '暂无已归档会话。'
                            : '暂无会话。创建一个，开始工作。'}
                      </p>
                    )}
                  {state && (
                    <div className="thread-pagination" aria-live="polite" aria-busy={state.loading}>
                      {state.loading || state.error || state.nextCursor ? (
                        <ControlHint content={state.error}>
                          <Button
                            variant="ghost"
                            className={cn('load-more', state.error && 'load-more-error')}
                            size="sm"
                            disabled={state.loading}
                            aria-describedby={
                              state.error ? `thread-pagination-error-${project.id}` : undefined
                            }
                            onClick={() => {
                              if (state.error) props.onRetry(project.id);
                              else if (state.nextCursor) props.onMore(project.id, state.nextCursor);
                            }}
                          >
                            {state.loading
                              ? '正在加载更多会话…'
                              : state.error
                                ? '加载失败，重试'
                                : '加载更多会话'}
                          </Button>
                        </ControlHint>
                      ) : state.loaded && state.data.length > 0 && !query ? (
                        <p className="sidebar-pagination-status">已加载全部会话</p>
                      ) : null}
                      {state.error && (
                        <span className="sr-only" id={`thread-pagination-error-${project.id}`}>
                          {state.error}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
          {groups.length === 0 && (
            <p className="sidebar-empty">
              {query
                ? '没有匹配的项目或已加载会话。'
                : props.projectsLoaded
                  ? '还没有项目。添加一个服务器目录，开始工作。'
                  : '正在读取项目…'}
            </p>
          )}
        </nav>
        <div className="sidebar-footer">
          <Button
            className="notification-settings-button"
            variant="ghost"
            size="sm"
            aria-label={`工作完成通知 · ${props.notificationStatus}`}
            onClick={props.onNotificationSettings}
          >
            <Bell size={15} aria-hidden="true" />
            <span>完成通知</span>
            <span className="notification-settings-status">{props.notificationStatus}</span>
          </Button>
          <span className="privacy-mark">服务器执行</span>
          <p>代码与凭据保留在运行服务的电脑上</p>
          <Button
            className="covro-update-button"
            variant="ghost"
            size="sm"
            aria-label="Covro 更新"
            onClick={props.onUpdates}
          >
            <ArrowUpCircle size={15} aria-hidden="true" />
            <span className="covro-version-label">Covro {props.appVersion}</span>
            <span className="notification-settings-status">
              {props.updating ? '更新中' : props.updateAvailable ? '有新版本' : '版本与更新'}
            </span>
          </Button>
        </div>
      </aside>
    </>
  );
}
