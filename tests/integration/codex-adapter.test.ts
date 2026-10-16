import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexAdapter,
  type AdapterEvent,
  type CodexAdapterOptions,
} from '../../src/codex/adapter.js';
import { mapItem, mapThread, permissionSettings } from '../../src/codex/mapping.js';
import type { Thread } from '../../src/codex/generated/v2/Thread.js';
import type { ThreadItem } from '../../src/codex/generated/v2/ThreadItem.js';
import type { SimulatorOptions } from '../fixtures/app-server.js';
const adapters: CodexAdapter[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(
  options: SimulatorOptions = {},
  timeout = 5000,
  overrides: Partial<CodexAdapterOptions> = {},
) {
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
    ...overrides,
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
async function replies(
  dir: string,
): Promise<{ id: string | number; result?: unknown; error?: unknown }[]> {
  return (await readFile(join(dir, 'requests.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((message) => !Object.hasOwn(message, 'method')) as {
    id: string | number;
    result?: unknown;
    error?: unknown;
  }[];
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
  it('preserves creator identity separately from source in creation, notifications and history', async () => {
    const { adapter, events } = await fixture();
    const thread = await adapter.createThread('/tmp');
    const identity = { id: thread.id, source: 'vscode', originator: 'codex_web_ui' };
    expect(thread).toMatchObject(identity);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'thread', thread: expect.objectContaining(identity) }),
    );
    expect(await adapter.readThreadMetadata(thread.id)).toMatchObject(identity);
    expect(await adapter.readThread(thread.id)).toMatchObject(identity);
    expect((await adapter.listThreads('/tmp')).data).toContainEqual(
      expect.objectContaining(identity),
    );
  });

  it.each([null, undefined])(
    'keeps a missing creator unknown (%s) without deriving it from source',
    (originator) => {
      const thread = {
        id: 'legacy',
        cwd: '/tmp',
        source: 'vscode',
        status: { type: 'idle' },
        turns: [],
        updatedAt: 0,
        ...(originator === undefined ? {} : { originator }),
      } as unknown as Thread;
      expect(mapThread(thread)).toMatchObject({ source: 'vscode', originator: null });
    },
  );

  it.each([
    [9, 142],
    [1, 1279],
  ])(
    'loads and resumes oversized history (%i turns, %i items each) within the old 8 MiB limit',
    async (turns, itemsPerTurn) => {
      const { adapter, requests } = await fixture(
        {
          paginated: true,
          history: { turns, itemsPerTurn, itemBytes: 7000 },
        },
        5000,
        { maxLineBytes: 8 * 1024 * 1024 },
      );
      const thread = await adapter.createThread('/tmp');
      const history = await adapter.readThread(thread.id);
      expect(history.turns).toHaveLength(turns);
      for (const turn of history.turns) {
        expect(turn.items).toHaveLength(itemsPerTurn);
        expect(turn.items.every((item) => item.output?.length === 7000)).toBe(true);
      }
      expect((await adapter.resumeThread(thread.id, thread.cwd)).turns).toEqual(history.turns);
      expect(adapter.ready).toBe(true);
      const calls = await requests();
      expect(
        calls
          .filter((call) => call.method === 'thread/turns/list')
          .every((call) => call.params.itemsView === 'summary'),
      ).toBe(true);
      expect(
        calls
          .filter((call) => call.method === 'thread/items/list')
          .every((call) => call.params.limit === 20),
      ).toBe(true);
      expect(calls.find((call) => call.method === 'thread/resume')?.params.excludeTurns).toBe(true);
    },
  );
  it('retains legacy history above 8 MiB with the new bounded default', async () => {
    const { adapter } = await fixture({
      history: { turns: 1, itemsPerTurn: 1, itemBytes: 9 * 1024 * 1024 },
    });
    const thread = await adapter.createThread('/tmp');
    expect(
      (await adapter.resumeThread(thread.id, thread.cwd)).turns[0]?.items[0]?.output?.length,
    ).toBe(9 * 1024 * 1024);
    expect(adapter.ready).toBe(true);
  });
  it('recovers from an oversized frame with a new epoch without replaying a turn', async () => {
    const { adapter, requests } = await fixture({ hugeLineBytes: 4096 }, 5000, {
      maxLineBytes: 2048,
    });
    const thread = await adapter.createThread('/tmp');
    const epoch = adapter.epoch;
    await expect(adapter.startTurn(thread.id, thread.cwd, 'private prompt')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      uncertain: true,
      details: {
        maxLineBytes: 2048,
        pendingRequests: [expect.objectContaining({ method: 'turn/start' })],
      },
    });
    await waitFor(() => (adapter.ready && adapter.epoch !== epoch ? true : undefined));
    expect(await adapter.createThread('/tmp')).toHaveProperty('id');
    expect((await requests()).filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });
  it('cancels a scheduled restart when stopped explicitly', async () => {
    const { adapter, requests } = await fixture({ crashAfterDispatch: true });
    const thread = await adapter.createThread('/tmp');
    await expect(adapter.startTurn(thread.id, thread.cwd, 'crash')).rejects.toMatchObject({
      uncertain: true,
    });
    await adapter.stop();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(adapter.ready).toBe(false);
    expect((await requests()).filter((call) => call.method === 'initialize')).toHaveLength(1);
  });
  it.each([false, true])(
    'uses native archive/list/unarchive for paginated=%s without relying on rollout paths',
    async (paginated) => {
      const { adapter, events, requests } = await fixture({ paginated });
      const thread = await adapter.createThread('/tmp');
      await adapter.archiveThread(thread.id);
      expect((await adapter.listThreads('/tmp')).data).toEqual([]);
      expect((await adapter.listThreads('/tmp', undefined, true)).data).toMatchObject([
        { id: thread.id, archived: true },
      ]);
      expect(await adapter.readThread(thread.id)).toMatchObject({ archived: true });
      expect(await adapter.readThreadMetadata(thread.id)).toMatchObject({ archived: true });
      expect(events).toContainEqual({ type: 'threadArchive', threadId: thread.id, archived: true });
      expect(await adapter.unarchiveThread(thread.id)).toMatchObject({
        id: thread.id,
        archived: false,
      });
      expect(await adapter.readThread(thread.id)).toMatchObject({ archived: false });
      const calls = await requests();
      expect(calls.filter((entry) => entry.method === 'thread/archive')).toHaveLength(1);
      expect(calls.filter((entry) => entry.method === 'thread/unarchive')).toHaveLength(1);
    },
  );

  it('does not send archive for an idle parent with an active spawned descendant', async () => {
    const { adapter, requests } = await fixture({ activeArchiveDescendant: true });
    const thread = await adapter.createThread('/tmp');
    await expect(adapter.archiveThread(thread.id)).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    expect((await requests()).some((entry) => entry.method === 'thread/archive')).toBe(false);
  });

  it('reports unsupported native archive and removes its capability without a local fallback', async () => {
    const { adapter } = await fixture({ unsupportedMethod: 'thread/archive' });
    const thread = await adapter.createThread('/tmp');
    await expect(adapter.archiveThread(thread.id)).rejects.toBeDefined();
    expect(adapter.diagnostics().capabilities).not.toContain('thread/archive');
    expect(await adapter.readThread(thread.id)).toMatchObject({ archived: false });
  });

  it.each([
    [-32600, 'thread {threadId} already has an active writer', 'THREAD_IN_USE'],
    [-32600, 'thread another-thread already has an active writer', 'CODEX_REQUEST_FAILED'],
    [-32600, 'Invalid history format', 'CODEX_REQUEST_FAILED'],
    [-32000, 'thread {threadId} already has an active writer', 'CODEX_REQUEST_FAILED'],
  ] as const)(
    'maps only the exact resume writer conflict (%s, %s)',
    async (code, message, expected) => {
      const { adapter } = await fixture({ resumeFailure: { code, message } });
      const thread = await adapter.createThread('/tmp');
      await expect(adapter.resumeThread(thread.id, thread.cwd)).rejects.toMatchObject({
        code: expected,
      });
    },
  );

  it('sends image-only turns and text-plus-image steering as native image input, and restores history', async () => {
    const { adapter, requests } = await fixture({ turnDelayMs: 2000 });
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const thread = await adapter.createThread('/tmp');
    const turn = await adapter.startTurn(thread.id, thread.cwd, '', undefined, [image]);
    await adapter.steerTurn(thread.id, turn.id, '  看第二张图\n', [image]);
    const calls = (await requests()).filter((entry) =>
      ['turn/start', 'turn/steer'].includes(entry.method),
    );
    expect(calls[0]?.params.input).toEqual([{ type: 'image', url: image }]);
    expect(calls[1]?.params.input).toEqual([
      { type: 'text', text: '  看第二张图\n', text_elements: [] },
      { type: 'image', url: image },
    ]);
    const history = await adapter.readThread(thread.id);
    expect(history.turns[0]?.items.filter((item) => item.type === 'userMessage')).toMatchObject([
      { text: '', images: [image], imageCount: 1 },
      { text: '  看第二张图\n', images: [image], imageCount: 1 },
    ]);
    const hidden = mapItem({
      id: 'external',
      type: 'userMessage',
      clientId: null,
      content: [
        { type: 'image', url: 'https://example.com/private.png' },
        { type: 'localImage', path: '/private/image.png' },
      ],
    });
    expect(hidden).toMatchObject({ images: [], imageCount: 2 });
    await adapter.interruptTurn(thread.id, turn.id);
  });
  it('preserves custom permission identities and their separately reported network access', () => {
    expect(
      permissionSettings(
        { type: 'externalSandbox', networkAccess: 'enabled' },
        {
          granular: {
            sandbox_approval: true,
            rules: false,
            skill_approval: true,
            request_permissions: true,
            mcp_elicitations: false,
          },
        },
        'auto_review',
      ),
    ).toEqual({
      sandbox: 'external-sandbox',
      approvalPolicy: 'granular',
      approvalReviewer: 'auto_review',
      networkAccess: true,
    });
    expect(permissionSettings()).toEqual({
      sandbox: null,
      approvalPolicy: null,
      approvalReviewer: null,
      networkAccess: null,
    });
  });
  it.each([false, true])(
    'reads title metadata without fetching history (paginated: %s) and maps name updates',
    async (paginated) => {
      const { adapter, events, requests } = await fixture({
        paginated,
        threadNames: ['自定义名称', ''],
        turnDelayMs: 10,
      });
      const thread = await adapter.createThread('/tmp');
      expect(thread.title).toBe('新会话');
      for (const [index, prompt] of ['第一条消息', '后续问题'].entries()) {
        const turn = await adapter.startTurn(thread.id, thread.cwd, prompt);
        await waitFor(() =>
          events.find(
            (event) =>
              event.type === 'turn' &&
              event.turn.id === turn.id &&
              event.turn.status === 'completed',
          ),
        );
        expect(events).toContainEqual({
          type: 'threadName',
          threadId: thread.id,
          name: index === 0 ? '自定义名称' : undefined,
        });
        const metadata = await adapter.readThreadMetadata(thread.id);
        expect(metadata.title).toBe(index === 0 ? '自定义名称' : '第一条消息');
        expect(metadata.turns).toEqual([]);
      }
      const historyRequests = (await requests()).filter(
        (request) =>
          request.method.startsWith('thread/') &&
          !['thread/start', 'thread/read', 'thread/list'].includes(request.method),
      );
      expect(historyRequests).toEqual([]);
      expect(
        (await requests())
          .filter((request) => request.method === 'thread/read')
          .map((request) => request.params),
      ).toEqual([
        { threadId: thread.id, includeTurns: false },
        { threadId: thread.id, includeTurns: false },
      ]);
    },
  );
  it('reads project-scoped defaults without exposing the rest of the config', async () => {
    const { adapter, requests } = await fixture({
      configModel: 'custom-model',
      configEffort: 'high',
    });
    expect(await adapter.readRuntimeSettings('/tmp/project')).toEqual({
      model: 'custom-model',
      reasoningEffort: 'high',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      approvalReviewer: 'user',
    });
    expect((await requests()).find((entry) => entry.method === 'config/read')?.params).toEqual({
      cwd: '/tmp/project',
      includeLayers: false,
    });
  });
  it('preserves unknown defaults and keeps a missing config API from disabling execution', async () => {
    const { adapter } = await fixture({ configModel: null, configEffort: null });
    expect(await adapter.readRuntimeSettings('/tmp')).toMatchObject({
      model: null,
      reasoningEffort: null,
    });
    const unsupported = (await fixture({ unsupportedMethod: 'config/read' })).adapter;
    await expect(unsupported.readRuntimeSettings('/tmp')).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
    });
    expect(unsupported.ready).toBe(true);
    expect((await unsupported.createThread('/tmp')).runtimeSettings?.model).toBe('simulated-model');
  });
  it.each([false, true])(
    'reports confirmed settings across create, turn, read, resume and fork (paginated: %s)',
    async (paginated) => {
      const { adapter, events } = await fixture({ paginated });
      const thread = await adapter.createThread('/tmp', { reasoningEffort: 'low' });
      expect(thread.runtimeSettings).toMatchObject({
        model: 'simulated-model',
        reasoningEffort: 'low',
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        networkAccess: false,
        approvalReviewer: 'user',
      });
      await adapter.startTurn(thread.id, '/tmp', 'settings', { reasoningEffort: 'high' });
      await waitFor(() => events.find((event) => event.type === 'threadSettings'));
      expect(events).toContainEqual({
        type: 'threadSettings',
        threadId: thread.id,
        settings: {
          model: 'simulated-model',
          reasoningEffort: 'high',
          sandbox: 'read-only',
          approvalPolicy: 'on-request',
          networkAccess: false,
          approvalReviewer: 'user',
        },
      });
      expect((await adapter.readThread(thread.id)).runtimeSettings?.reasoningEffort).toBe('high');
      expect((await adapter.resumeThread(thread.id, '/tmp')).runtimeSettings?.reasoningEffort).toBe(
        'high',
      );
      expect(
        (await adapter.forkThread(thread.id, '/tmp', { reasoningEffort: 'low' })).runtimeSettings
          ?.reasoningEffort,
      ).toBe('low');
    },
  );
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
    const list = (await requests()).find(
      (entry) => entry.method === 'thread/list' && !entry.params.archived,
    );
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
    const request = (await requests()).find(
      (entry) => entry.method === 'thread/list' && !entry.params.archived,
    );
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
    expect(
      (await requests()).filter(
        (entry) => entry.method === 'turn/start' && entry.params.threadId === thread.id,
      ),
    ).toHaveLength(1);
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
        source: 'vscode',
        originator: 'codex_web_ui',
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
  it.each([
    ['accept', 'turn'],
    ['acceptForSession', 'session'],
    ['decline', 'turn'],
  ] as const)(
    'answers permission %s with the exact original profile and %s scope',
    async (decision, scope) => {
      const permissions = {
        network: { enabled: true },
        fileSystem: {
          read: ['/tmp/reference'],
          write: ['/tmp/report.txt'],
          globScanMaxDepth: 2,
          entries: [
            {
              path: { type: 'glob_pattern' as const, pattern: '/tmp/reports/*.png' },
              access: 'write' as const,
            },
            {
              path: { type: 'special' as const, value: { kind: 'tmpdir' as const } },
              access: 'read' as const,
            },
            { path: { type: 'path' as const, path: '/tmp/private' }, access: 'deny' as const },
          ],
        },
      };
      const { adapter, events, dir } = await fixture({ approval: 'permissions', permissions });
      const thread = await adapter.createThread('/tmp');
      await adapter.startTurn(thread.id, thread.cwd, 'permission scope');
      const incoming = await waitFor(() => events.find((event) => event.type === 'action'));
      if (incoming.type !== 'action') throw new Error('Wrong event');
      expect(incoming.action).toMatchObject({
        kind: 'permissions',
        status: 'pending',
      });
      expect(incoming.action.blocking).not.toBe(false);
      expect(incoming.action.options.map((option) => option.id)).toEqual([
        'accept',
        'acceptForSession',
        'decline',
      ]);
      const unsubscribe = adapter.onEvent(() => {});
      unsubscribe();
      expect((await adapter.readThread(thread.id)).status).toBe('waitingApproval');
      expect(await replies(dir)).toEqual([]);
      await expect(
        adapter.respond(incoming.action.actionId, {
          decision: 'accept',
          content: { network: true },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(
        adapter.respond(incoming.action.actionId, { decision: 'cancel' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await replies(dir)).toEqual([]);
      await adapter.respond(incoming.action.actionId, { decision });
      await expect(adapter.respond(incoming.action.actionId, { decision })).rejects.toMatchObject({
        code: 'ACTION_CONFLICT',
      });
      await waitFor(() => events.find((event) => event.type === 'actionResolved'));
      expect(await replies(dir)).toEqual([
        { id: 0, result: { permissions: decision === 'decline' ? {} : permissions, scope } },
      ]);
      await expect(adapter.respond(incoming.action.actionId, { decision })).rejects.toMatchObject({
        code: 'ACTION_EXPIRED',
      });
      await waitFor(() =>
        events.find(
          (event) =>
            event.type === 'turn' &&
            event.turn.status === (decision === 'decline' ? 'interrupted' : 'completed'),
        ),
      );
    },
  );
  it.each([
    { network: { enabled: true }, fileSystem: null },
    { network: null, fileSystem: { read: null, write: ['/tmp/only-this-file'] } },
    { network: null, fileSystem: null },
  ])('never adds omitted requested permissions: %j', async (permissions) => {
    const { adapter, events, dir } = await fixture({ approval: 'permissions', permissions });
    const thread = await adapter.createThread('/tmp');
    await adapter.startTurn(thread.id, thread.cwd, 'limited permissions');
    const incoming = await waitFor(() => events.find((event) => event.type === 'action'));
    if (incoming.type !== 'action') throw new Error('Wrong event');
    await adapter.respond(incoming.action.actionId, { decision: 'accept' });
    await waitFor(() => events.find((event) => event.type === 'actionResolved'));
    expect(await replies(dir)).toEqual([
      {
        id: 0,
        result: {
          permissions: Object.fromEntries(
            Object.entries(permissions).filter(([, value]) => value !== null),
          ),
          scope: 'turn',
        },
      },
    ]);
  });
  it.each(['elicitation-form', 'elicitation-openai', 'elicitation-openai-form'] as const)(
    'accepts %s typed values only after valid explicit input',
    async (approval) => {
      const { adapter, events, dir } = await fixture({ approval, elicitationTurnId: null });
      const thread = await adapter.createThread('/tmp');
      await adapter.startTurn(thread.id, thread.cwd, 'structured MCP input');
      const incoming = await waitFor(() => events.find((event) => event.type === 'action'));
      if (incoming.type !== 'action') throw new Error('Wrong event');
      expect(incoming.action).toMatchObject({
        kind: 'elicitation',
        status: 'pending',
        elicitation: { mode: 'form', serverName: '截图发布服务' },
      });
      expect(incoming.action.turnId).toBeUndefined();
      expect(incoming.action.elicitation?.schemaError).toBeUndefined();
      const content = {
        project: '截图项目',
        retries: 0,
        rating: 4.5,
        notify: false,
        environment: 'preview',
        channels: ['web', 'mobile'],
      };
      for (const invalid of [
        {},
        { ...content, retries: '2' },
        { ...content, retries: 1.5 },
        { ...content, retries: 6 },
        { ...content, rating: -1 },
        { ...content, notify: 'false' },
        { ...content, environment: 'invented' },
        { ...content, channels: [] },
        { ...content, channels: ['web', 'web'] },
        { ...content, channels: ['invented'] },
        { ...content, unexpected: 'field' },
      ]) {
        await expect(
          adapter.respond(incoming.action.actionId, { decision: 'accept', content: invalid }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      }
      expect(await replies(dir)).toEqual([]);
      expect((await adapter.readThread(thread.id)).status).toBe('waitingInput');
      await adapter.respond(incoming.action.actionId, { decision: 'accept', content });
      await waitFor(() => events.find((event) => event.type === 'actionResolved'));
      expect(await replies(dir)).toEqual([
        { id: 0, result: { action: 'accept', content, _meta: null } },
      ]);
      await waitFor(() =>
        events.find((event) => event.type === 'turn' && event.turn.status === 'completed'),
      );
    },
  );
  it.each(['decline', 'cancel'] as const)(
    'returns MCP %s unchanged without content or tool execution',
    async (decision) => {
      const { adapter, events, dir } = await fixture({ approval: 'elicitation-form' });
      const thread = await adapter.createThread('/tmp');
      await adapter.startTurn(thread.id, thread.cwd, 'structured MCP input');
      const incoming = await waitFor(() => events.find((event) => event.type === 'action'));
      if (incoming.type !== 'action') throw new Error('Wrong event');
      await expect(
        adapter.respond(incoming.action.actionId, { decision, content: { project: 'unexpected' } }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await adapter.respond(incoming.action.actionId, { decision });
      await waitFor(() => events.find((event) => event.type === 'actionResolved'));
      expect(await replies(dir)).toEqual([
        { id: 0, result: { action: decision, content: null, _meta: null } },
      ]);
      const interrupted = await waitFor(() =>
        events.find((event) => event.type === 'turn' && event.turn.status === 'interrupted'),
      );
      if (interrupted.type !== 'turn') throw new Error('Wrong event');
      expect(interrupted.turn.items.some((item) => item.type === 'commandExecution')).toBe(false);
    },
  );
  it('keeps URL elicitation waiting until explicitly acknowledged and returns no form content', async () => {
    const { adapter, events, dir } = await fixture({ approval: 'elicitation-url' });
    const thread = await adapter.createThread('/tmp');
    await adapter.startTurn(thread.id, thread.cwd, 'authorize external service');
    const incoming = await waitFor(() => events.find((event) => event.type === 'action'));
    if (incoming.type !== 'action') throw new Error('Wrong event');
    expect(incoming.action.elicitation).toMatchObject({
      mode: 'url',
      url: 'https://example.com/authorize?service=screenshots',
    });
    expect(await replies(dir)).toEqual([]);
    await expect(
      adapter.respond(incoming.action.actionId, { decision: 'accept', content: {} }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await adapter.respond(incoming.action.actionId, { decision: 'accept' });
    await waitFor(() => events.find((event) => event.type === 'actionResolved'));
    expect(await replies(dir)).toEqual([
      { id: 0, result: { action: 'accept', content: null, _meta: null } },
    ]);
  });
  it('shows unsupported form schemas as pending, rejects accept, and lets the user explicitly decline', async () => {
    const { adapter, events, dir } = await fixture({ approval: 'elicitation-malformed' });
    const thread = await adapter.createThread('/tmp');
    await adapter.startTurn(thread.id, thread.cwd, 'unknown form schema');
    const incoming = await waitFor(() => events.find((event) => event.type === 'action'));
    if (incoming.type !== 'action') throw new Error('Wrong event');
    expect(incoming.action).toMatchObject({
      kind: 'elicitation',
      status: 'pending',
      elicitation: { schemaError: expect.any(String) },
    });
    expect(await replies(dir)).toEqual([]);
    await expect(
      adapter.respond(incoming.action.actionId, { decision: 'accept', content: {} }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await adapter.respond(incoming.action.actionId, { decision: 'decline' });
    await waitFor(() => events.find((event) => event.type === 'actionResolved'));
    expect(await replies(dir)).toEqual([
      { id: 0, result: { action: 'decline', content: null, _meta: null } },
    ]);
  });
  it.each(['permissions', 'elicitation-form'] as const)(
    'expires %s requests on interrupted turns without granting or answering',
    async (approval) => {
      const { adapter, events, dir } = await fixture({ approval });
      const thread = await adapter.createThread('/tmp');
      const turn = await adapter.startTurn(thread.id, thread.cwd, 'interrupt approval');
      const incoming = await waitFor(() => events.find((event) => event.type === 'action'));
      if (incoming.type !== 'action') throw new Error('Wrong event');
      await adapter.interruptTurn(thread.id, turn.id);
      await waitFor(() =>
        events.find((event) => event.type === 'turn' && event.turn.status === 'interrupted'),
      );
      await expect(
        adapter.respond(incoming.action.actionId, { decision: 'decline' }),
      ).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
      expect(await replies(dir)).toEqual([]);
    },
  );
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
