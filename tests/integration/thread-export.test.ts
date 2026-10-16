import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createApp } from '../../src/server/http.js';
import { parseConfig } from '../../src/server/config.js';
import { renderThreadExport } from '../../src/server/thread-export.js';
import type { ThreadView } from '../../src/shared/types.js';
import { deferred, harness, threadView } from './domain-helpers.js';

const resources: ReturnType<typeof harness>[] = [];
function setup() {
  const resource = harness();
  resources.push(resource);
  const config = parseConfig(
    { projects: [{ id: 'project', name: 'Test', path: resource.project }] },
    join(resource.directory, 'config.json'),
  );
  return {
    ...resource,
    app: createApp({ config, service: resource.service, staticDir: resource.directory }),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) resource.close();
});
function history(cwd: string): ThreadView {
  return {
    ...threadView('export-thread', cwd),
    title: '完整会话',
    status: 'completed',
    turns: Array.from({ length: 3 }, (_, index) => ({
      id: `turn-${index}`,
      threadId: 'export-thread',
      status: 'completed',
      items: [
        { id: `user-${index}`, type: 'userMessage', text: `第 ${index + 1} 条用户消息` },
        { id: `agent-${index}`, type: 'agentMessage', text: `第 ${index + 1} 条助手回复` },
      ],
    })),
  };
}

describe('thread Markdown exports', () => {
  it('reads fresh full history instead of a cached slice and sends a private downloadable response', async () => {
    const { codex, service, project, app } = setup();
    const full = history(project);
    codex.threads.set(full.id, full);
    service.projection.thread({ ...full, projectId: 'project', historyTruncated: true, turns: [] });
    const reads = vi.spyOn(codex, 'readThread');
    const response = await app.request('http://127.0.0.1:8787/api/threads/export-thread/export');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="codex-thread-export-thread-history.md"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-export-completeness')).toBe('saved-history');
    const markdown = await response.text();
    expect(markdown).toContain('第 1 条用户消息');
    expect(markdown).toContain('第 3 条助手回复');
    expect(markdown).not.toContain('会话历史已截断');
    expect(reads).toHaveBeenCalledWith(full.id);
    expect(service.projection.get(full.id)?.turns).toHaveLength(0);
    expect(codex.starts + codex.resumes + codex.forks).toBe(0);
  });

  it('includes literal tool output and diffs, counts omitted images, and never serializes internal payloads', () => {
    const thread = history('/private/working-directory');
    thread.id = '../unsafe\r\nname';
    thread.turns[0]!.items = [
      {
        id: 'u',
        type: 'userMessage',
        text: '查看截图',
        imageCount: 3,
        images: ['data:private-image', 'https://private.example/image'],
      },
      {
        id: 'tool',
        type: 'commandExecution',
        command: 'printf hello',
        output: 'before\n```\n# literal\nafter',
        cwd: '/private/cwd',
        details: { token: 'hidden-tool-token' },
      },
      {
        id: 'file',
        type: 'fileChange',
        changes: [{ path: 'src/main.ts', kind: 'update', diff: '-old\n+new' }],
      },
      { id: 'internal', type: 'mcpToolCall', details: { accessToken: 'hidden-auth-secret' } },
      { id: 'reasoning', type: 'reasoning', text: 'hidden-reasoning-content' },
    ];
    const exported = renderThreadExport(thread, { exportedAt: new Date('2026-01-01T00:00:00Z') });
    expect(exported.filename).toMatch(/^codex-thread-[A-Za-z0-9_-]+-history\.md$/);
    expect(exported.markdown).toContain('3 张图片未嵌入');
    expect(exported.markdown).toContain('````text\nbefore\n```\n# literal\nafter\n````');
    expect(exported.markdown).toContain('```diff\n-old\n+new\n```');
    for (const secret of [
      'hidden-tool-token',
      'hidden-auth-secret',
      'hidden-reasoning-content',
      'data:private-image',
      'private.example',
      '/private/cwd',
      '/private/working-directory',
    ])
      expect(exported.markdown).not.toContain(secret);
    expect(exported.markdown).toContain('此类记录的内部内容未导出');
  });

  it('marks active, uncertain and truncated content as partial instead of final output', () => {
    const thread = history('/project');
    thread.status = 'running';
    thread.turns[2]!.status = 'running';
    thread.turns[1]!.items[0]!.truncated = true;
    const exported = renderThreadExport(thread, { executionUncertain: true });
    expect(exported.partial).toBe(true);
    expect(exported.filename).toBe('codex-thread-export-thread-history-partial.md');
    expect(exported.markdown).toContain('不是完整的最终结果');
    expect(exported.markdown).toContain('此轮尚未完成');
    expect(exported.markdown).toContain('内容已截断');
    expect(exported.markdown).toContain('未结束或待核对的执行记录');
  });

  it('refuses a known partial history or a failed fresh read instead of exporting the cached copy', async () => {
    const { codex, service, project } = setup();
    const full = history(project);
    codex.threads.set(full.id, { ...full, historyTruncated: true });
    service.projection.thread({ ...full, projectId: 'project' });
    await expect(service.exportThread(full.id)).rejects.toMatchObject({
      code: 'EXPORT_HISTORY_INCOMPLETE',
    });
    vi.spyOn(codex, 'readThread').mockRejectedValue(new Error('history unavailable'));
    await expect(service.exportThread(full.id)).rejects.toThrow('history unavailable');
  });

  it('enforces project ownership and authenticates the export endpoint', async () => {
    const { codex, service, directory, app } = setup();
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    const full = history(outside);
    codex.threads.set(full.id, full);
    await expect(service.exportThread(full.id)).rejects.toMatchObject({
      code: 'PROJECT_OWNERSHIP',
    });
    const response = await app.request('http://untrusted.example/api/threads/export-thread/export');
    expect(response.status).toBe(403);
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('does not claim a consistent snapshot when metadata changes during the full read', async () => {
    const { codex, service, project } = setup();
    const full = history(project);
    codex.threads.set(full.id, full);
    vi.spyOn(codex, 'readThreadMetadata').mockResolvedValue({ ...full, status: 'running' });
    const exported = await service.exportThread(full.id);
    expect(exported.partial).toBe(true);
    expect(exported.markdown).toContain('读取期间会话发生变化');
  });

  it('rejects a read across runtime restart and a project removed during export', async () => {
    const { codex, service, project, projects } = setup();
    const full = history(project);
    codex.threads.set(full.id, full);
    const pending = deferred<ThreadView>();
    vi.spyOn(codex, 'readThread').mockReturnValueOnce(pending.promise);
    const exporting = service.exportThread(full.id);
    codex.reset();
    pending.resolve(full);
    await expect(exporting).rejects.toMatchObject({ code: 'EXPORT_RUNTIME_CHANGED' });
    const delayed = deferred<ThreadView>();
    vi.mocked(codex.readThread).mockReturnValueOnce(delayed.promise);
    const removed = service.exportThread(full.id);
    projects.remove('project');
    delayed.resolve(full);
    await expect(removed).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});
