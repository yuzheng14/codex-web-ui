import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventHub } from '../../src/server/events.js';
import { Projection } from '../../src/server/projection.js';
import { compactThreadForTransport } from '../../src/server/snapshot.js';
import { containsPath, ProjectRegistry } from '../../src/server/projects.js';
import type { ServerMessage, ThreadView } from '../../src/shared/types.js';

function threadView(id: string, cwd: string): ThreadView {
  return {
    id,
    cwd,
    projectId: '',
    source: 'appServer',
    title: id,
    status: 'idle',
    turns: [],
    actions: [],
    managed: false,
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'codex-projects-'));
  directories.push(path);
  return path;
}

describe('snapshot boundary, bounded events, and projection identity', () => {
  it('delivers a delta and terminal event triggered at snapshot delivery without gaps', () => {
    const hub = new EventHub();
    const thread = threadView('t', '/project');
    const received: ServerMessage[] = [];
    const unsubscribe = hub.subscribe(
      't',
      () => thread,
      undefined,
      (message) => {
        received.push(message);
        if (message.type === 'snapshot') {
          hub.publish('thread', { ...thread, status: 'running' }, 't');
          hub.publish('thread', { ...thread, status: 'completed' }, 't');
        }
      },
    );
    expect(received.map((message) => message.type)).toEqual(['snapshot', 'event', 'event']);
    expect(received.map((message) => ('cursor' in message ? message.cursor.seq : -1))).toEqual([
      0, 1, 2,
    ]);
    unsubscribe();
  });

  it('replays only matching and global events, tolerates sequence gaps, and snapshots expired cursors', () => {
    const hub = new EventHub(2000);
    const thread = threadView('a', '/project');
    hub.publish('thread', thread, 'a');
    const cursor = hub.cursor();
    hub.publish('thread', { ...thread, id: 'b' }, 'b');
    hub.publish('thread', { ...thread, title: '更新' }, 'a');
    const received: ServerMessage[] = [];
    hub.subscribe(
      'a',
      () => thread,
      cursor,
      (message) => received.push(message),
    )();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'event', cursor: { seq: 3 } });
    for (let i = 0; i < 20; i++) hub.publish('thread', { ...thread, title: 'x'.repeat(300) }, 'a');
    const expired: ServerMessage[] = [];
    hub.subscribe(
      'a',
      () => thread,
      cursor,
      (message) => expired.push(message),
    )();
    expect(expired).toHaveLength(1);
    expect(expired[0]?.type).toBe('snapshot');
    const reloaded: ServerMessage[] = [];
    hub.subscribe(
      'a',
      () => thread,
      undefined,
      (message) => reloaded.push(message),
    )();
    expect(reloaded[0]?.type).toBe('snapshot');
    const differentEpoch: ServerMessage[] = [];
    hub.subscribe(
      'a',
      () => thread,
      { serverEpoch: 'old', seq: 10 },
      (message) => differentEpoch.push(message),
    )();
    expect(differentEpoch[0]?.type).toBe('snapshot');
  });

  it('does not let a throwing browser stop delivery to healthy browsers', () => {
    const hub = new EventHub();
    const thread = threadView('t', '/p');
    const received: ServerMessage[] = [];
    hub.subscribe(
      't',
      () => thread,
      undefined,
      () => {
        throw new Error('socket closed');
      },
    );
    hub.subscribe(
      't',
      () => thread,
      undefined,
      (message) => received.push(message),
    );
    expect(() => hub.publish('thread', thread, 't')).not.toThrow();
    expect(received).toHaveLength(2);
  });

  it('merges by stable IDs, replaces full items, bounds streamed UTF-8 output, and retains control state', () => {
    const projection = new Projection(20);
    const thread = threadView('t', '/p');
    projection.thread(thread);
    projection.turn('t', { id: 'turn', threadId: 't', status: 'running', items: [] });
    projection.item('t', 'turn', { id: 'a', type: 'agentMessage', text: '相同' });
    projection.item('t', 'turn', { id: 'b', type: 'agentMessage', text: '相同' });
    projection.delta('t', 'turn', 'a', 'text', '内容');
    projection.item('t', 'turn', { id: 'a', type: 'agentMessage', text: '完整替换' });
    expect(projection.get('t')!.turns[0]!.items.map((item) => item.text)).toEqual([
      '完整替换',
      '相同',
    ]);
    projection.delta('t', 'turn', 'output', 'output', '中文'.repeat(100));
    expect(projection.get('t')!.turns[0]!.items[2]).toMatchObject({ truncated: true });
    expect(projection.get('t')!.turns[0]!.items[2]!.output).toContain('输出已截断');
    projection.turn('t', {
      id: 'turn',
      threadId: 't',
      status: 'failed',
      items: [],
      error: 'tool failed',
    });
    expect(projection.get('t')).toMatchObject({
      status: 'failed',
      turns: [{ error: 'tool failed' }],
    });
    expect(projection.get('t')!.turns[0]!.items).toHaveLength(3);
  });

  it('preserves delta item types and truncates diffs and generic activity details', () => {
    const projection = new Projection(20);
    projection.thread(threadView('t', '/p'));
    projection.turn('t', { id: 'turn', threadId: 't', status: 'running', items: [] });
    projection.delta('t', 'turn', 'reasoning', 'text', '想一想', 'reasoning');
    projection.diff('t', 'turn', '+new line\n'.repeat(100));
    projection.item('t', 'turn', {
      id: 'files',
      type: 'fileChange',
      changes: [{ path: 'a', kind: 'update', diff: '+x'.repeat(100) }],
      details: { large: 'x'.repeat(100) },
    });
    const turn = projection.get('t')!.turns[0]!;
    expect(turn.items[0]?.type).toBe('reasoning');
    expect(turn.diff).toContain('输出已截断');
    expect(turn.items[1]?.truncated).toBe(true);
  });

  it('keeps nonblocking questions visible without claiming the turn is waiting for input', () => {
    const projection = new Projection();
    projection.thread(threadView('t', '/p'));
    projection.turn('t', { id: 'turn', threadId: 't', status: 'running', items: [] });
    projection.action({
      actionId: 'question',
      codexEpoch: 'epoch',
      rpcId: 0,
      kind: 'questions',
      threadId: 't',
      turnId: 'turn',
      status: 'pending',
      blocking: false,
      title: '一个非阻塞问题',
      options: [],
      questions: [],
    });
    expect(projection.get('t')?.status).toBe('running');
    expect(projection.get('t')?.actions).toHaveLength(1);
  });

  it('compacts many large items to a recoverable snapshot without changing authoritative history or pending controls', () => {
    const thread = threadView('t', '/project');
    thread.status = 'waitingApproval';
    thread.turns = Array.from({ length: 5 }, (_, index) => ({
      id: `turn-${index}`,
      threadId: 't',
      status: index === 4 ? 'waitingApproval' : 'completed',
      diff: 'diff'.repeat(100_000),
      items: [
        { id: `item-${index}`, type: 'commandExecution', output: 'x'.repeat(2 * 1024 * 1024) },
      ],
    }));
    thread.actions = [
      {
        actionId: 'approval',
        codexEpoch: 'epoch',
        rpcId: 0,
        threadId: 't',
        turnId: 'turn-4',
        kind: 'command',
        status: 'pending',
        title: '运行命令',
        options: [{ id: 'accept', label: '允许' }],
      },
    ];
    thread.execution = {
      operationId: 'operation',
      threadId: 't',
      turnId: 'turn-4',
      workspaceKey: '/project',
      codexEpoch: 'epoch',
      ended: false,
    };
    const snapshot = compactThreadForTransport(thread, 2048);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(2048);
    expect(snapshot).toMatchObject({
      historyTruncated: true,
      status: 'waitingApproval',
      execution: thread.execution,
      actions: thread.actions,
    });
    expect(snapshot.turns.at(-1)?.id).toBe('turn-4');
    expect(thread.turns[0]?.items[0]?.output).toHaveLength(2 * 1024 * 1024);
    expect(thread.historyTruncated).toBeUndefined();
  });
});

describe('realpath ownership and checkout identity', () => {
  it('rejects sibling prefixes and symlinks escaping a registered directory', () => {
    const root = directory();
    const project = join(root, 'project');
    const sibling = join(root, 'project-other');
    mkdirSync(project);
    mkdirSync(sibling);
    symlinkSync(sibling, join(project, 'outside'));
    const registry = new ProjectRegistry([{ id: 'p', name: 'p', path: project }]);
    expect(containsPath(project, sibling)).toBe(false);
    expect(() => registry.assertOwnership('p', sibling)).toThrow('不属于');
    expect(() => registry.assertOwnership('p', join(project, 'outside'))).toThrow('不属于');
    expect(() => registry.get('unregistered')).toThrow('未注册');
  });

  it('uses the real Git checkout root for nested aliases while allowing distinct worktrees', () => {
    const root = directory();
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    execFileSync('git', ['init', checkout], { stdio: 'ignore' });
    execFileSync(
      'git',
      [
        '-C',
        checkout,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { stdio: 'ignore' },
    );
    const worktree = join(root, 'worktree');
    execFileSync('git', ['-C', checkout, 'worktree', 'add', '-b', 'test-worktree', worktree], {
      stdio: 'ignore',
    });
    const nested = join(checkout, 'nested');
    mkdirSync(nested);
    const alias = join(root, 'alias');
    symlinkSync(checkout, alias);
    const registry = new ProjectRegistry([
      { id: 'checkout', name: 'checkout', path: checkout },
      { id: 'nested', name: 'nested', path: nested },
      { id: 'alias', name: 'alias', path: alias },
      { id: 'worktree', name: 'worktree', path: worktree },
    ]);
    expect(registry.get('checkout').workspaceKey).toBe(registry.get('nested').workspaceKey);
    expect(registry.get('checkout').workspaceKey).toBe(registry.get('alias').workspaceKey);
    expect(registry.get('checkout').workspaceKey).not.toBe(registry.get('worktree').workspaceKey);
  });
});
