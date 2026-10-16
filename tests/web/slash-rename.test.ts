import { describe, expect, it, vi } from 'vitest';
import { threadNameError } from '../../src/shared/thread-name';
import { renameThreadSchema } from '../../src/shared/validation';
import {
  createSlashCommands,
  validateSlashCommand,
  type SlashCommandContext,
} from '../../src/web/lib/slash-commands';

function context(): SlashCommandContext {
  return {
    project: {
      id: 'project',
      name: 'Project',
      rootPath: '/tmp',
      canonicalRoot: '/tmp',
      workspaceKey: '/tmp',
      available: true,
    },
    selectedId: 'thread/one',
    thread: {
      id: 'thread/one',
      projectId: 'project',
      cwd: '/tmp',
      title: 'Old',
      source: 'appServer',
      status: 'running',
      managed: true,
      turns: [],
      actions: [],
    },
    system: {
      ready: true,
      connection: 'ready',
      codexVersion: '0.162.1',
      verifiedVersion: '0.162.1',
      compatibility: 'verified',
      compatibilityConfirmation: 'not-required',
      codexEpoch: 'epoch',
      authenticated: true,
      authMode: 'local',
      models: [],
      capabilities: ['thread/name/set'],
      demo: true,
    },
    connection: 'connected',
    authRequired: false,
    settings: {},
    projectSettings: {},
    busy: [],
    operations: [],
    run: vi.fn().mockResolvedValue({
      status: 'acknowledged',
      result: { threadId: 'thread/one', name: '发布前 检查 🧪' },
    }),
    onResumeAttempt: vi.fn(),
    refreshThread: vi.fn(),
    openStatus: vi.fn(),
  };
}
const rename = (state: SlashCommandContext) =>
  createSlashCommands(() => state).find((entry) => entry.name === 'rename')!;

describe('slash rename', () => {
  it('validates required, single-line names and Unicode length consistently', () => {
    const commands = createSlashCommands(context);
    expect(validateSlashCommand('/rename', commands)).toContain('/rename <名称>');
    for (const name of [
      '',
      '   ',
      'line\nbreak',
      'tab\tname',
      'control\u0000',
      'x'.repeat(101),
      '🧪'.repeat(101),
    ]) {
      expect(threadNameError(name)).toBeDefined();
      expect(
        renameThreadSchema.safeParse({ clientOperationId: crypto.randomUUID(), name }).success,
      ).toBe(false);
    }
    expect(threadNameError('🧪'.repeat(100))).toBeUndefined();
    expect(validateSlashCommand('/rename 发布前 检查 🧪', commands)).toBeUndefined();
    expect(
      renameThreadSchema.parse({
        clientOperationId: crypto.randomUUID(),
        name: '  发布前 检查 🧪  ',
      }).name,
    ).toBe('发布前 检查 🧪');
    expect(validateSlashCommand('/new extra', commands)).toContain('不接受参数');
  });

  it('renames a running managed thread without sending a prompt or changing its selection', async () => {
    const state = context();
    expect(rename(state).usage).toBe('/rename <名称>');
    expect(await rename(state).run('  发布前 检查 🧪  ')).toEqual({
      message: '会话已重命名为「发布前 检查 🧪」。',
    });
    expect(state.run).toHaveBeenCalledWith(
      'rename',
      'thread/one',
      '/api/threads/thread%2Fone/rename',
      { name: '发布前 检查 🧪' },
    );
    expect(state.refreshThread).not.toHaveBeenCalled();
  });

  it('explains ownership, archive and uncertain rename limitations', async () => {
    const state = context();
    state.thread!.managed = false;
    expect(rename(state).unavailableReason).toContain('先恢复');
    state.thread!.managed = true;
    state.thread!.archived = true;
    expect(rename(state).unavailableReason).toContain('取消归档');
    state.thread!.archived = false;
    state.operations = [
      {
        kind: 'rename',
        target: 'thread/one',
        clientOperationId: 'pending',
        status: 'unknown',
        createdAt: 1,
      },
    ];
    expect(rename(state).unavailableReason).toContain('尚未确认');
    await rename(state).run('Name');
    expect(state.run).not.toHaveBeenCalled();
  });

  it('revalidates parameters and context even when run directly, and requires a confirmed name', async () => {
    let state = context();
    const command = createSlashCommands(() => state).find((entry) => entry.name === 'rename')!;
    expect(await command.run()).toMatchObject({
      error: true,
      message: expect.stringContaining('/rename'),
    });
    expect(state.run).not.toHaveBeenCalled();
    state = { ...state, selectedId: 'other' };
    expect(await command.run('Name')).toMatchObject({
      error: true,
      message: expect.stringContaining('已切换'),
    });
    state = { ...state, selectedId: 'thread/one' };
    state.run = vi.fn().mockResolvedValue({ status: 'unknown' });
    expect(await rename(state).run('Name')).toMatchObject({ error: true });
    state.run = vi.fn().mockResolvedValue({ status: 'acknowledged', result: {} });
    expect(await rename(state).run('Name')).toMatchObject({ error: true });
  });
});
