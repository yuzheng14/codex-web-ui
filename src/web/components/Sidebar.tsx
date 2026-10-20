import { UNASSIGNED_SCOPE } from '../../shared/workspace-scope';
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
import { ThreadListNavigation } from './ThreadListNavigation';

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
  onGatewaySettings: () => void;
  notificationStatus: string;
  onUpdates: () => void;
  appVersion?: string;
  updateAvailable: boolean;
  updating: boolean;
}

export function Sidebar(props: Props) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const scopes = [
    {
      id: UNASSIGNED_SCOPE,
      name: '未关联项目',
      rootPath: '',
      available: true,
      error: undefined,
      project: undefined as Project | undefined,
    },
    ...props.projects.map((project) => ({ ...project, project })),
  ];
  const groups = scopes.flatMap((project) => {
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
              <img src="/covro.svg" alt="" width="28" height="28" />
            </div>
            <ControlHint
              asChild
              side="bottom"
              align="start"
              content={`Covro ${props.appVersion ?? ''} · ${props.updating ? '更新中' : props.updateAvailable ? '有新版本' : '版本与更新'}`}
            >
              <button
                type="button"
                className="brand-name covro-brand-button"
                aria-label="Covro 更新"
                data-update-available={props.updateAvailable || props.updating}
                onClick={props.onUpdates}
              >
                Covro <ArrowUpCircle size={13} aria-hidden="true" />
              </button>
            </ControlHint>
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
              {query
                ? `搜索结果 · ${groups.length} 个分组`
                : `全部会话 · ${props.projects.length} 个项目`}
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
              disabled={!props.projectsLoaded}
            >
              <Icon name="refresh" size={14} />
            </Button>
          </div>
        </div>
        <ThreadListNavigation context={`${props.archiveView}:${query}`} rows={props.projectThreads}>
          {groups.map(({ project, state, threads }) => {
            const activeCount = (state?.data ?? []).filter((entry) =>
              isActive(entry.status),
            ).length;
            const createLabel = props.creating(project.id)
              ? '正在创建…'
              : project.project
                ? '新建会话'
                : '新建会话（无需项目）';
            return (
              <section
                key={project.id}
                className="project-group"
                aria-label={project.name}
                data-project-id={project.project?.id}
                data-scope-id={project.id}
              >
                <h2 className="project-heading">
                  <ControlHint asChild content={project.name}>
                    <button
                      className="project-link"
                      onClick={() => props.onProject(project.id)}
                      aria-current={props.projectId === project.id ? 'true' : undefined}
                    >
                      <Icon name={project.project ? 'folder' : 'code'} size={16} />
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
                  <ControlHint content={createLabel}>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={createLabel}
                      onClick={() => props.onCreate(project.id)}
                      disabled={!props.canCreate(project.id) || props.creating(project.id)}
                    >
                      <Icon name={props.creating(project.id) ? 'loader' : 'plus'} size={15} />
                    </Button>
                  </ControlHint>
                  {project.project && (
                    <ControlHint content={'管理项目'}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`管理项目 ${project.name}`}
                        onClick={() => props.onManageProject(project.project!)}
                        disabled={!props.canManageProjects}
                      >
                        <Icon name="settings" size={15} />
                      </Button>
                    </ControlHint>
                  )}
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
                      {Boolean(state.unverified?.length) && (
                        <p className="sidebar-pagination-status" role="status">
                          {state.error
                            ? '本机列表同步失败，可继续浏览。'
                            : state.loading
                              ? '正在显示本机列表，后台同步中…'
                              : '部分本机列表尚未同步，加载更多以核对。'}
                        </p>
                      )}
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
                              ? state.appending
                                ? '正在加载更多会话…'
                                : '正在同步会话…'
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
                  ? '暂无会话。直接新建会话，或添加项目。'
                  : '正在读取项目…'}
            </p>
          )}
        </ThreadListNavigation>
        <div className="sidebar-footer">
          <Button
            className="gateway-settings-button"
            variant="ghost"
            size="sm"
            onClick={props.onGatewaySettings}
          >
            <Icon name="settings" size={15} />
            <span>服务配置</span>
          </Button>
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
        </div>
      </aside>
    </>
  );
}
