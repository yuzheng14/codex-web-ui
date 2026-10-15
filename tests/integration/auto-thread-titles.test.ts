import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter, type AdapterEvent } from '../../src/codex/adapter.js';
import type { SimulatorOptions } from '../fixtures/app-server.js';

const resources: { adapter: CodexAdapter; directory: string }[] = [];
afterEach(async () => {
  for (const { adapter, directory } of resources.splice(0)) {
    await adapter.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture(options: SimulatorOptions = {}, titleTimeoutMs = 3000) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-auto-title-'));
  const logPath = join(directory, 'requests.jsonl');
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ turnDelayMs: 10, ...options, logPath }),
    ],
    titleTimeoutMs,
  });
  resources.push({ adapter, directory });
  const events: AdapterEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.start();
  const requests = async () =>
    (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            method?: string;
            params?: Record<string, unknown>;
            error?: unknown;
          },
      );
  return { adapter, events, requests };
}

it('generates once outside the user history, persists the title, and hides temporary events', async () => {
  const { adapter, events, requests } = await fixture({ titleDelayMs: 150, ackDelayMs: 30 });
  const thread = await adapter.createThread('/tmp');
  const prompt = '解释一下运行设置如何继承 Codex 配置';
  const first = await adapter.startTurn(thread.id, thread.cwd, prompt);
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe(prompt);
  await vi.waitFor(async () => {
    expect((await adapter.readThreadMetadata(thread.id)).title).toBe('Codex 配置继承与运行设置');
  });
  expect(events).toContainEqual({
    type: 'threadName',
    threadId: thread.id,
    name: 'Codex 配置继承与运行设置',
  });
  const history = await adapter.readThread(thread.id);
  expect(history.turns.map((turn) => turn.id)).toEqual([first.id]);
  expect(history.turns[0]?.items.find((item) => item.type === 'userMessage')?.text).toBe(prompt);
  await adapter.startTurn(thread.id, thread.cwd, '后续消息');
  await vi.waitFor(async () => {
    expect(
      (await requests()).filter((entry) => entry.method === 'thread/unsubscribe'),
    ).toHaveLength(1);
  });
  const sent = await requests();
  expect(sent.filter((entry) => entry.method === 'thread/name/set')).toHaveLength(1);
  const temporary = sent.find(
    (entry) => entry.method === 'thread/start' && entry.params?.ephemeral,
  );
  expect(temporary?.params).toMatchObject({
    ephemeral: true,
    model: 'simulated-model',
    modelProvider: 'openai',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    config: {
      'features.shell_tool': false,
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
      'features.multi_agent': false,
      web_search: 'disabled',
      mcp_servers: { 'fixture.tools': { enabled: false } },
    },
  });
  expect(temporary?.params).toHaveProperty('config.mcp_servers', {
    'fixture.tools': { enabled: false },
  });
  expect(
    sent.find((entry) => entry.method === 'turn/start' && entry.params?.threadId !== thread.id)
      ?.params,
  ).toMatchObject({ effort: 'low', outputSchema: { required: ['title'] } });
  expect(events.filter((event) => event.type === 'thread').map((event) => event.thread.id)).toEqual(
    [thread.id],
  );
  expect(
    events.filter((event) => 'threadId' in event).every((event) => event.threadId === thread.id),
  ).toBe(true);
  expect((await adapter.listThreads(thread.cwd)).data.map((entry) => entry.id)).toEqual([
    thread.id,
  ]);
});

it.each(['not json', '{}', '{"title":"   "}', JSON.stringify({ title: '长'.repeat(81) })])(
  'keeps the preview when the title output is invalid: %s',
  async (titleOutput) => {
    const { adapter, requests } = await fixture({ titleOutput });
    const thread = await adapter.createThread('/tmp');
    await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
    await vi.waitFor(async () =>
      expect((await requests()).some((r) => r.method === 'thread/unsubscribe')).toBe(true),
    );
    expect((await adapter.readThreadMetadata(thread.id)).title).toBe('第一条问题');
    expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(false);
    expect(adapter.ready).toBe(true);
  },
);

it('accepts a late thread/started notification without losing the naming job', async () => {
  const { adapter, requests } = await fixture({ threadStartedDelayMs: 30, titleDelayMs: 100 });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  await vi.waitFor(async () =>
    expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(true),
  );
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe('Codex 配置继承与运行设置');
});

it.each(['fail', 'hang', 'rename', 'interaction'] as const)(
  'cleans up a %s naming attempt without changing task execution',
  async (titleBehavior) => {
    const { adapter, events, requests } = await fixture({ titleBehavior }, 150);
    const thread = await adapter.createThread('/tmp');
    const turn = await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
    await vi.waitFor(async () =>
      expect((await requests()).some((r) => r.method === 'thread/unsubscribe')).toBe(true),
    );
    const history = await adapter.readThread(thread.id);
    expect(history.title).toBe(titleBehavior === 'rename' ? '用户手动命名' : '第一条问题');
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0]).toMatchObject({ id: turn.id, status: 'completed' });
    expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(false);
    expect(events.some((event) => event.type === 'action')).toBe(false);
    if (titleBehavior === 'hang') {
      const interrupt = (await requests()).find((r) => r.method === 'turn/interrupt');
      expect(interrupt?.params?.threadId).toBeDefined();
      expect(interrupt?.params?.threadId).not.toBe(thread.id);
    }
    expect(adapter.ready).toBe(true);
  },
);

it('does not rename explicitly named sessions, including a name equal to the placeholder', async () => {
  const { adapter, requests } = await fixture({ threadNames: ['新会话'] });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  expect((await adapter.readThreadMetadata(thread.id)).title).toBe('新会话');
  expect((await requests()).some((r) => r.params?.ephemeral)).toBe(false);
});

it('does not auto-name a fork, and isolates two concurrent naming jobs', async () => {
  const { adapter, requests } = await fixture();
  const first = await adapter.createThread('/tmp');
  const second = await adapter.createThread('/tmp');
  await Promise.all(
    [first, second].map((thread) => adapter.startTurn(thread.id, thread.cwd, thread.id)),
  );
  await vi.waitFor(async () =>
    expect((await requests()).filter((r) => r.method === 'thread/name/set')).toHaveLength(2),
  );
  const fork = await adapter.forkThread(first.id, first.cwd);
  await adapter.startTurn(fork.id, fork.cwd, 'fork 后的问题');
  expect((await requests()).filter((r) => r.params?.ephemeral)).toHaveLength(2);
  expect((await adapter.readThread(fork.id)).turns).toHaveLength(2);
});

it('cancels pending naming when the runtime stops and never sends it to the replacement process', async () => {
  const { adapter, requests } = await fixture({ titleBehavior: 'hang' });
  const thread = await adapter.createThread('/tmp');
  await adapter.startTurn(thread.id, thread.cwd, '第一条问题');
  await vi.waitFor(async () =>
    expect((await requests()).filter((r) => r.method === 'turn/start')).toHaveLength(2),
  );
  await adapter.stop();
  await adapter.start();
  expect(adapter.ready).toBe(true);
  expect((await requests()).some((r) => r.method === 'thread/name/set')).toBe(false);
});
