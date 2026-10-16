import { useState } from 'react';
import type { Project, ThreadSummary } from '../../shared/types';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { isActive } from './Status';
import { ThreadLink } from './ThreadLink';

interface ProjectThreads {
  data: ThreadSummary[];
  nextCursor: string | null;
  loading: boolean;
  error?: string;
}
interface Props {
  archiveView: boolean;
  onArchiveView: (archived: boolean) => void;
  onArchive: (id: string, archived: boolean) => void;
  archiveDisabledReason: (thread: ThreadSummary) => string | undefined;
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
        <div className="project-search">
          <label className="eyebrow" htmlFor="project-search">
            项目与会话
          </label>
          <input
            id="project-search"
            type="search"
            aria-label="搜索项目与已加载会话"
            placeholder="搜索项目与已加载会话"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="archive-switch" aria-label="会话列表范围">
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
        <div className="section-label">
          <span>{query ? '搜索结果' : `全部项目 · ${props.projects.length}`}</span>
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
        <nav className="project-list" aria-label="会话历史">
          {groups.map(({ project, state, threads }) => {
            const activeCount = (state?.data ?? []).filter((entry) =>
              isActive(entry.status),
            ).length;
            return (
              <section
                key={project.id}
                className={cn('project-group', props.projectId === project.id && 'project-active')}
                aria-label={project.name}
                data-project-id={project.id}
              >
                <h2 className="project-heading">
                  <button
                    className="project-link"
                    onClick={() => props.onProject(project.id)}
                    aria-current={props.projectId === project.id ? 'true' : undefined}
                    title={project.name}
                  >
                    <Icon name="folder" size={16} />
                    <span>{project.name}</span>
                    {activeCount > 0 && (
                      <span className="project-activity" aria-label={`${activeCount} 个进行中会话`}>
                        {activeCount}
                      </span>
                    )}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`管理项目 ${project.name}`}
                    title="管理项目"
                    onClick={() => props.onManageProject(project)}
                    disabled={!props.canManageProjects}
                  >
                    <Icon name="settings" size={15} />
                  </Button>
                </h2>
                <p className="project-path" title={project.rootPath}>
                  {project.rootPath}
                </p>
                {!project.available && (
                  <p className="inline-error project-error" role="status">
                    {project.error ?? '项目目录不可用'}
                  </p>
                )}
                <Button
                  className="new-thread"
                  variant="secondary"
                  size="sm"
                  onClick={() => props.onCreate(project.id)}
                  disabled={!props.canCreate(project.id) || props.creating(project.id)}
                >
                  <Icon name="plus" size={14} />
                  {props.creating(project.id) ? '正在创建…' : '新建会话'}
                </Button>
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
                      onSelect={() => {
                        props.onThread(entry.id, project.id);
                        props.onClose();
                      }}
                    />
                  ))}
                  {state?.error && (
                    <div className="project-list-error" role="status">
                      <p>{state.error}</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={state.loading}
                        onClick={() => props.onRetry(project.id)}
                      >
                        重试加载会话
                      </Button>
                    </div>
                  )}
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
                  {state?.loading && (
                    <p className="sidebar-empty" role="status">
                      正在读取会话…
                    </p>
                  )}
                  {state?.nextCursor && (
                    <Button
                      variant="ghost"
                      className="load-more"
                      size="sm"
                      disabled={state.loading}
                      onClick={() => props.onMore(project.id, state.nextCursor!)}
                    >
                      加载更多会话
                    </Button>
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
          <span className="privacy-mark">服务器执行</span>
          <p>代码与凭据保留在运行服务的电脑上</p>
        </div>
      </aside>
    </>
  );
}
