import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter, type AdapterEvent } from '../../src/codex/adapter.js';
import { mapItem } from '../../src/codex/mapping.js';
import type { ThreadItem } from '../../src/codex/generated/v2/ThreadItem.js';
import type { SimulatorOptions } from '../fixtures/app-server.js';
const adapters: CodexAdapter[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(options: SimulatorOptions = {}, timeout = 5000) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-adapter-'));
  dirs.push(dir);
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ ...options, logPath: join(dir, 'requests.jsonl') }),
    ],
    requestTimeoutMs: timeout,
  });
  adapters.push(adapter);
  const events: AdapterEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.start();
  return {
    adapter,
    events,
    dir,
    requests: async () =>
      (await readFile(join(dir, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> }),
  };
}
async function waitFor<T>(get: () => T | undefined): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for simulator event');
}

describe('verified protocol adapter with a real subprocess', () => {
  it('handshakes before business operations, maps deltas/tool output, paginates history and explicitly includes CLI sources', async () => {
    const { adapter, events, requests } = await fixture({
      fragmentBytes: 1,
      paginated: true,
      turnDelayMs: 100,
    });
    const thread = await adapter.createThread('/tmp');
    const turn = await adapter.startTurn(thread.id, '/tmp', '你好');
    expect(turn.status).toBe('running');
    await waitFor(() =>
      events.find((event) => event.type === 'turn' && event.turn.status === 'completed'),
    );
    const history = await adapter.readThread(thread.id);
    expect(history.turns[0]?.items.some((item) => item.output?.includes('你好 Codex'))).toBe(true);
    expect(history.turns[0]?.items.some((item) => item.changes?.[0]?.diff.includes('+你好'))).toBe(
      true,
    );
    await adapter.listThreads('/tmp');
    const list = (await requests()).find((entry) => entry.method === 'thread/list');
    const methods = (await requests()).map((entry) => entry.method);
    expect(methods.slice(0, 4)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'model/list',
    ]);
    expect(list?.params.sourceKinds).toEqual(['cli', 'appServer', 'vscode']);
    expect(list?.params).not.toHaveProperty('cwd');
    expect(adapter.diagnostics().authenticated).toBe(true);
    expect(adapter.diagnostics().compatibility).toBe('unverified'); // Node's version must not pretend to be Codex.
  });
  it('leaves exact-path filtering to the service so alias and subdirectory history remain discoverable', async () => {
    const { adapter, requests } = await fixture();
    const alias = await adapter.createThread('/tmp/project-alias');
    const nested = await adapter.createThread('/tmp/project/nested');
    const page = await adapter.listThreads('/tmp/project', 'opaque-cursor');
    expect(page.data.map((thread) => thread.id)).toEqual([alias.id, nested.id]);
    const request = (await requests()).find((entry) => entry.method === 'thread/list');
    expect(request?.params).toMatchObject({
      cursor: 'opaque-cursor',
      sourceKinds: ['cli', 'appServer', 'vscode'],
    });
    expect(request?.params).not.toHaveProperty('cwd');
  });
  it('allows events before delayed acknowledgement; a timeout never resends a prompt', async () => {
    const { adapter, events, requests } = await fixture({ ackDelayMs: 800, turnDelayMs: 10 }, 500);
    const thread = await adapter.createThread('/tmp');
    await expect(adapter.startTurn(thread.id, '/tmp', 'test')).rejects.toMatchObject({
      uncertain: true,
    });
    expect(events.some((event) => event.type === 'turn' && event.turn.status === 'completed')).toBe(
      true,
    );
    expect((await requests()).filter((entry) => entry.method === 'turn/start')).toHaveLength(1);
  });
  it.each([false, true])(
    'forks complete persisted history (paginated: %s) into an independent thread',
    async (paginated) => {
      const { adapter, events, requests } = await fixture({
        paginated,
        historyPageSize: 1,
        historyItemSummaries: true,
        turnDelayMs: 10,
      });
      const source = await adapter.createThread('/tmp/project');
      expect(source).not.toHaveProperty('forkedFromId');
      for (const text of ['first question', 'second question']) {
        const turn = await adapter.startTurn(source.id, source.cwd, text);
        await waitFor(() =>
          events.find(
            (event) =>
              event.type === 'turn' &&
              event.turn.id === turn.id &&
              event.turn.status === 'completed',
          ),
        );
      }
      const before = await adapter.readThread(source.id);
      const fork = await adapter.forkThread(source.id, source.cwd, {
        model: 'simulated-model',
        reasoningEffort: 'high',
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
      });
      expect(fork.id).not.toBe(source.id);
      expect(fork).toMatchObject({
        forkedFromId: source.id,
        cwd: source.cwd,
        source: 'appServer',
        status: 'idle',
        actions: [],
      });
      expect(fork.turns).toEqual(before.turns.map((turn) => ({ ...turn, threadId: fork.id })));
      expect(fork.turns).toHaveLength(2);
      expect(fork.turns[0]?.items).toHaveLength(4);
      expect(await adapter.readThread(source.id)).toEqual(before);
      const dispatched = await requests();
      expect(dispatched.filter((request) => request.method === 'thread/fork')).toEqual([
        {
          method: 'thread/fork',
          params: {
            threadId: source.id,
            cwd: source.cwd,
            model: 'simulated-model',
            approvalPolicy: 'untrusted',
            sandbox: 'read-only',
            config: { model_reasoning_effort: 'high' },
            excludeTurns: true,
          },
          id: expect.any(Number),
        },
      ]);
      expect(
        dispatched.some((request) => ['thread/resume', 'turn/interrupt'].includes(request.method)),
      ).toBe(false);
      const forkReads = dispatched.filter((request) => request.params?.threadId === fork.id);
      if (paginated) {
        expect(forkReads.filter((request) => request.method === 'thread/turns/list')).toHaveLength(
          2,
        );
        expect(forkReads.filter((request) => request.method === 'thread/items/list')).toHaveLength(
          8,
        );
      } else {
        expect(forkReads).toContainEqual({
          method: 'thread/read',
          params: { threadId: fork.id, includeTurns: true },
          id: expect.any(Number),
        });
      }
    },
  );
  it('forks an active thread without interrupting it or sharing mutable history', async () => {
    const { adapter, requests } = await fixture({ turnDelayMs: 5000 });
    const source = await adapter.createThread('/tmp');
    const active = await adapter.startTurn(source.id, source.cwd, 'still running');
    const fork = await adapter.forkThread(source.id, source.cwd);
    expect(fork).toMatchObject({
      status: 'idle',
      turns: [{ id: active.id, status: 'interrupted' }],
    });
    const continued = await adapter.startTurn(fork.id, fork.cwd, 'continue separately');
    expect(continued.status).toBe('running');
    const original = await adapter.readThread(source.id);
    expect(original).toMatchObject({
      status: 'running',
      turns: [{ id: active.id, status: 'running' }],
    });
    expect(original.turns).toHaveLength(1);
    expect((await adapter.readThread(fork.id)).turns).toHaveLength(2);
    expect(
      (await requests()).some((request) =>
        ['thread/resume', 'turn/interrupt'].includes(request.method),
      ),
    ).toBe(false);
  });
  it('keeps source approvals valid and creates no copied pending action when forking', async () => {
    const { adapter, events } = await fixture({ approval: 'command' });
    const source = await adapter.createThread('/tmp');
    await adapter.startTurn(source.id, source.cwd, 'wait for approval');
    const incoming = await waitFor(() => events.find((event) => event.type === 'action'));
    if (incoming.type !== 'action') throw new Error('Wrong event');
    const fork = await adapter.forkThread(source.id, source.cwd);
    expect(fork.actions).toEqual([]);
    expect(events.filter((event) => event.type === 'action')).toHaveLength(1);
    expect((await adapter.readThread(source.id)).status).toBe('waitingApproval');
    await adapter.respond(incoming.action.actionId, { decision: 'accept' });
    await waitFor(() =>
      events.find(
        (event) => event.type === 'actionResolved' && event.actionId === incoming.action.actionId,
      ),
    );
  });
  it('validates fork settings before dispatch and disables an explicitly unsupported fork method', async () => {
    const { adapter, requests } = await fixture({ unsupportedMethod: 'thread/fork' });
    const source = await adapter.createThread('/tmp');
    await expect(
      adapter.forkThread(source.id, source.cwd, { model: 'missing' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      adapter.forkThread(source.id, source.cwd, { reasoningEffort: 'missing' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await requests()).filter((request) => request.method === 'thread/fork')).toHaveLength(
      0,
    );
    expect(adapter.diagnostics().capabilities).toContain('thread/fork');
    await expect(adapter.forkThread(source.id, source.cwd)).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
      uncertain: false,
    });
    await expect(adapter.forkThread(source.id, source.cwd)).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
      uncertain: false,
    });
    expect(adapter.diagnostics().capabilities).not.toContain('thread/fork');
    expect(adapter.ready).toBe(true);
    expect((await requests()).filter((request) => request.method === 'thread/fork')).toHaveLength(
      1,
    );
  });
  it.each([
    { forkHistoryReadError: true },
    { unsupportedMethod: 'thread/read' },
    { malformedForkReceipt: true },
  ])(
    'keeps a completed fork uncertain when its receipt or history cannot be read: %j',
    async (options) => {
      const { adapter, requests } = await fixture(options);
      const source = await adapter.createThread('/tmp');
      const failure = await adapter
        .forkThread(source.id, source.cwd)
        .catch((error: unknown) => error);
      const fork = (await adapter.listThreads(source.cwd)).data.find(
        (thread) => thread.forkedFromId === source.id,
      );
      expect(fork).toBeDefined();
      expect(failure).toMatchObject({
        uncertain: true,
        message: expect.stringContaining(fork!.id),
      });
      expect((await requests()).filter((request) => request.method === 'thread/fork')).toHaveLength(
        1,
      );
    },
  );
  it.each(['command', 'file', 'network'] as const)(
    'keeps %s approval pending across listeners and resolves only with upstream evidence',
    async (approval) => {
      const { adapter, events } = await fixture({ approval });
      const thread = await adapter.createThread('/tmp');
      await adapter.startTurn(thread.id, '/tmp', 'approval');
      const incoming = await waitFor(() =>
        events.find((event) => event.type === 'action' && event.action.status === 'pending'),
      );
      if (incoming.type !== 'action') throw new Error('Wrong event');
      expect(incoming.action.rpcId).toBe(0);
      expect(incoming.action.kind).toBe(approval);
      await expect(
        adapter.respond(incoming.action.actionId, { decision: 'invented' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await adapter.respond(incoming.action.actionId, { decision: 'accept' });
      await expect(
        adapter.respond(incoming.action.actionId, { decision: 'accept' }),
      ).rejects.toMatchObject({ code: 'ACTION_CONFLICT' });
      await waitFor(() => events.find((event) => event.type === 'actionResolved'));
      if (approval === 'network') expect(incoming.action.title).toContain('https://example.com');
    },
  );
  it('validates every structured question and exact option/free-text constraints', async () => {
    const { adapter, events, dir } = await fixture({ approval: 'questions' });
    const thread = await adapter.createThread('/tmp');
    await adapter.startTurn(thread.id, '/tmp', 'questions');
    const incoming = await waitFor(() =>
      events.find((event) => event.type === 'action' && event.action.kind === 'questions'),
    );
    if (incoming.type !== 'action') throw new Error('Wrong event');
    await expect(
      adapter.respond(incoming.action.actionId, { answers: { theme: ['其他'], name: ['名字'] } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      adapter.respond(incoming.action.actionId, { answers: { theme: ['深色'] } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await adapter.respond(incoming.action.actionId, {
      answers: { theme: ['深色'], name: ['名字'] },
    });
    await waitFor(() => events.find((event) => event.type === 'actionResolved'));
    const messages = (await readFile(join(dir, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages.find((message) => Object.hasOwn(message, 'result'))).toEqual({
      id: 0,
      result: { answers: { theme: { answers: ['深色'] }, name: { answers: ['名字'] } } },
    });
  });
  it('preserves the upstream nonblocking question contract', async () => {
    const { adapter, events } = await fixture({
      approval: 'questions',
      nonblockingQuestions: true,
    });
    const thread = await adapter.createThread('/tmp');
    await adapter.startTurn(thread.id, '/tmp', 'questions');
    const incoming = await waitFor(() =>
      events.find((event) => event.type === 'action' && event.action.kind === 'questions'),
    );
    expect(incoming).toMatchObject({ action: { blocking: false } });
    expect(
      events.some((event) => event.type === 'threadStatus' && event.status === 'running'),
    ).toBe(true);
  });
  it('rejects unsupported interactive RPC and reports compatibility trouble without silently waiting', async () => {
    const { adapter, events } = await fixture({ approval: 'unsupported' });
    const thread = await adapter.createThread('/tmp');
    await adapter.startTurn(thread.id, '/tmp', 'unsupported');
    const event = await waitFor(() => events.find((entry) => entry.type === 'action'));
    expect(event).toMatchObject({ action: { kind: 'unsupported', status: 'expired' } });
    await waitFor(() =>
      events.find((entry) => entry.type === 'turn' && entry.turn.status === 'interrupted'),
    );
  });
  it('interrupts the actual turn and makes old actions invalid after process shutdown', async () => {
    const { adapter, events } = await fixture({ approval: 'command' });
    const thread = await adapter.createThread('/tmp');
    const turn = await adapter.startTurn(thread.id, '/tmp', 'wait');
    const action = await waitFor(() => events.find((event) => event.type === 'action'));
    await adapter.interruptTurn(thread.id, turn.id);
    await waitFor(() =>
      events.find((event) => event.type === 'turn' && event.turn.status === 'interrupted'),
    );
    if (action.type !== 'action') throw new Error('Wrong event');
    await expect(
      adapter.respond(action.action.actionId, { decision: 'accept' }),
    ).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    await adapter.stop();
    expect(adapter.ready).toBe(false);
  });
  it('keeps a malformed mutating receipt uncertain because the turn may already have started', async () => {
    const { adapter } = await fixture({ malformedTurnReceipt: true });
    const thread = await adapter.createThread('/tmp');
    await expect(
      adapter.startTurn(thread.id, '/tmp', 'malformed acknowledgement'),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE', uncertain: true });
  });
  it('marks pending dispatch uncertain when its own child crashes', async () => {
    const { adapter } = await fixture({ crashAfterDispatch: true });
    const thread = await adapter.createThread('/tmp');
    await expect(adapter.startTurn(thread.id, '/tmp', 'crash')).rejects.toMatchObject({
      uncertain: true,
    });
    expect(adapter.ready).toBe(false);
  });
  it('disables a missing method after an explicit upstream unsupported response', async () => {
    const { adapter, requests } = await fixture({ unsupportedMethod: 'thread/start' });
    await expect(adapter.createThread('/tmp')).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
      uncertain: false,
    });
    await expect(adapter.createThread('/tmp')).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
    });
    expect((await requests()).filter((entry) => entry.method === 'thread/start')).toHaveLength(1);
  });
  it('preserves readable future activity items using their stable upstream ID', () => {
    const item = {
      id: 'new-tool',
      type: 'futureTool',
      payload: { result: 'hello' },
    } as unknown as ThreadItem;
    expect(mapItem(item)).toEqual({ id: 'new-tool', type: 'futureTool', details: item });
  });
});
