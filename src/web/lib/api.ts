import type {
  ApiError,
  RuntimeSettings,
  Operation,
  Project,
  SystemInfo,
  ThreadSummaryPage,
  ThreadView,
} from '../../shared/types';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly problem: ApiError,
  ) {
    super(problem.message);
    this.name = 'HttpError';
  }
  get authenticationRequired() {
    return this.status === 401 || this.status === 403 || this.problem.code === 'AUTH_REQUIRED';
  }
}

export async function request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers:
      body === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(35_000),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new HttpError(response.status === 200 ? 401 : response.status, {
      code: 'AUTH_REQUIRED',
      message: '登录已过期，或入口返回了登录页面。请重新登录后恢复连接。',
    });
  }
  const data: unknown = await response.json();
  if (!response.ok) {
    const problem =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error: ApiError }).error
        : undefined;
    throw new HttpError(
      response.status,
      problem ?? { code: 'HTTP_ERROR', message: `请求失败（${response.status}）` },
    );
  }
  return data as T;
}

export const api = {
  system: () => request<SystemInfo>('/api/system'),
  runtimeSettings: (projectId: string) =>
    request<RuntimeSettings>(`/api/projects/${encodeURIComponent(projectId)}/runtime-settings`),
  projects: () => request<{ data: Project[] }>('/api/projects'),
  addProject: (input: { path: string; name?: string }) => request<Project>('/api/projects', input),
  renameProject: (id: string, name: string) =>
    request<Project>(`/api/projects/${encodeURIComponent(id)}/rename`, { name }),
  removeProject: (id: string) =>
    request<{ removed: true }>(`/api/projects/${encodeURIComponent(id)}/remove`, {}),
  threads: (projectId: string, cursor?: string, archived = false) =>
    request<ThreadSummaryPage>(
      `/api/projects/${encodeURIComponent(projectId)}/threads${archived ? '?archived=true' : ''}${cursor ? `${archived ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  thread: (threadId: string) => request<ThreadView>(`/api/threads/${encodeURIComponent(threadId)}`),
  operation: (id: string) => request<Operation>(`/api/operations/${encodeURIComponent(id)}`),
  submit: (path: string, body: object) => request<Operation>(path, body),
};
