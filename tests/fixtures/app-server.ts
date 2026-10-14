/** Explicit test process. Its envelopes and payloads use the CLI-generated 0.162.1 protocol. */
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { ClientRequest } from '../../src/codex/generated/ClientRequest.js';
import type { ServerNotification } from '../../src/codex/generated/ServerNotification.js';
import type { ServerRequest } from '../../src/codex/generated/ServerRequest.js';
import type { Thread } from '../../src/codex/generated/v2/Thread.js';
import type { Turn } from '../../src/codex/generated/v2/Turn.js';
import type { ThreadItem } from '../../src/codex/generated/v2/ThreadItem.js';
import type { Model } from '../../src/codex/generated/v2/Model.js';
import type { ThreadStartResponse } from '../../src/codex/generated/v2/ThreadStartResponse.js';
import type { InitializeResponse } from '../../src/codex/generated/InitializeResponse.js';
import type { RequestId } from '../../src/codex/generated/RequestId.js';

export interface SimulatorOptions {
  fragmentBytes?: number;
  ackDelayMs?: number;
  turnDelayMs?: number;
  outputBytes?: number;
  crashAfterDispatch?: boolean;
  unsupportedMethod?: string;
  logPath?: string;
  paginated?: boolean;
  historyPageSize?: number;
  historyItemSummaries?: boolean;
  forkHistoryReadError?: boolean;
  malformedForkReceipt?: boolean;
  approval?: 'command' | 'file' | 'network' | 'questions' | 'unsupported';
  malformed?: boolean;
  hugeLineBytes?: number;
  malformedTurnReceipt?: boolean;
  nonblockingQuestions?: boolean;
}
const optionsIndex = process.argv.indexOf('--options');
const options = JSON.parse(
  optionsIndex < 0 ? '{}' : (process.argv[optionsIndex + 1] ?? '{}'),
) as SimulatorOptions;
const threads = new Map<string, Thread>();
const finishes = new Map<string, NodeJS.Timeout>();
const callbacks = new Map<RequestId, () => void>();
let initialized = false;
let handshaken = false;
let nextRequestId = 0;
let writes = Promise.resolve();
function send(message: unknown): void {
  const data = Buffer.from(JSON.stringify(message) + '\n');
  writes = writes.then(async () => {
    const size = Math.max(1, options.fragmentBytes ?? data.length);
    for (let offset = 0; offset < data.length; offset += size) {
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(data.subarray(offset, offset + size), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
  });
}
function notify(event: ServerNotification): void {
  send(event);
}
function reply(id: RequestId, result: unknown): void {
  send({ id, result });
}
function error(id: RequestId, message: string, code = -32602): void {
  send({ id, error: { code, message } });
}
function makeThread(cwd: string): Thread {
  const id = randomUUID();
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: options.paginated ? 'paginated' : 'legacy',
    modelProvider: 'openai',
    model: 'simulated-model',
    reasoningEffort: 'medium',
    createdAt: Date.now() / 1000,
    updatedAt: Date.now() / 1000,
    recencyAt: null,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: '0.162.1',
    originator: 'simulator',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}
function startResponse(thread: Thread): ThreadStartResponse {
  return {
    thread,
    model: 'simulated-model',
    modelProvider: 'openai',
    serviceTier: null,
    disabledPluginIds: [],
    cwd: thread.cwd,
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    reasoningEffort: 'medium',
  };
}
function command(id: string, cwd: string): Extract<ThreadItem, { type: 'commandExecution' }> {
  return {
    type: 'commandExecution',
    id,
    pluginId: null,
    scriptPath: null,
    command: 'printf "你好 Codex"',
    cwd,
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
}
function complete(
  thread: Thread,
  turn: Turn,
  status: 'completed' | 'interrupted' = 'completed',
): void {
  clearTimeout(finishes.get(turn.id));
  finishes.delete(turn.id);
  if (turn.status !== 'inProgress') return;
  turn.status = status;
  turn.completedAt = Date.now() / 1000;
  thread.status = { type: 'idle' };
  // Explicit test prompt: retain real terminal history while dropping its notification.
  if (!thread.preview.includes('[miss-completion]'))
    notify({ method: 'turn/completed', params: { threadId: thread.id, turn } });
  notify({
    method: 'thread/status/changed',
    params: { threadId: thread.id, status: thread.status },
  });
  if (thread.preview.includes('[unload]')) {
    // Exercise the real notification → gateway cache → history-read recovery path.
    thread.status = { type: 'notLoaded' };
    notify({
      method: 'thread/status/changed',
      params: { threadId: thread.id, status: thread.status },
    });
  }
}
function execute(thread: Thread, turn: Turn): void {
  const cmd = command(randomUUID(), thread.cwd);
  turn.items.push(cmd);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item: cmd, startedAtMs: Date.now() },
  });
  const output = '你好 Codex\n' + 'x'.repeat(options.outputBytes ?? 0);
  for (let offset = 0; offset < output.length; offset += 8192)
    notify({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        itemId: cmd.id,
        delta: output.slice(offset, offset + 8192),
      },
    });
  cmd.aggregatedOutput = output;
  cmd.status = 'completed';
  cmd.exitCode = 0;
  notify({
    method: 'item/completed',
    params: { threadId: thread.id, turnId: turn.id, item: cmd, completedAtMs: Date.now() },
  });
  const diff = '--- a/hello.txt\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+你好 Codex\n';
  const file: ThreadItem = {
    id: randomUUID(),
    type: 'fileChange',
    status: 'completed',
    changes: [{ path: 'hello.txt', kind: { type: 'add' }, diff }],
  };
  turn.items.push(file);
  notify({
    method: 'item/completed',
    params: { threadId: thread.id, turnId: turn.id, item: file, completedAtMs: Date.now() },
  });
  notify({ method: 'turn/diff/updated', params: { threadId: thread.id, turnId: turn.id, diff } });
  const item: ThreadItem = {
    id: randomUUID(),
    type: 'agentMessage',
    text: '',
    phase: 'final_answer',
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  turn.items.push(item);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() },
  });
  notify({
    method: 'item/agentMessage/delta',
    params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: '模拟任务已完成。' },
  });
  item.text = '模拟任务已完成。';
  notify({
    method: 'item/completed',
    params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
  });
  finishes.set(
    turn.id,
    setTimeout(() => complete(thread, turn), options.turnDelayMs ?? 100),
  );
}
function approval(
  thread: Thread,
  turn: Turn,
  kind: NonNullable<SimulatorOptions['approval']>,
): void {
  const id = nextRequestId++;
  const common = { threadId: thread.id, turnId: turn.id, itemId: randomUUID() };
  let request: ServerRequest;
  if (kind === 'questions')
    request = {
      id,
      method: 'item/tool/requestUserInput',
      params: {
        ...common,
        isBlocking: !options.nonblockingQuestions,
        autoResolutionMs: null,
        questions: [
          {
            id: 'theme',
            header: '主题',
            question: '选择主题',
            isOther: false,
            isSecret: false,
            options: [
              { label: '深色', description: '深色界面' },
              { label: '浅色', description: '浅色界面' },
            ],
          },
          {
            id: 'name',
            header: '名称',
            question: '输入名称',
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    };
  else if (kind === 'file')
    request = {
      id,
      method: 'item/fileChange/requestApproval',
      params: {
        ...common,
        startedAtMs: Date.now(),
        reason: '需要写入测试文件',
        grantRoot: thread.cwd,
      },
    };
  else if (kind === 'unsupported') {
    send({ id, method: 'future/requestApproval', params: common });
    callbacks.set(id, () => complete(thread, turn, 'interrupted'));
    return;
  } else
    request = {
      id,
      method: 'item/commandExecution/requestApproval',
      params: {
        ...common,
        kind: 'command',
        startedAtMs: Date.now(),
        environmentId: null,
        reason: '执行测试命令',
        ...(kind === 'network'
          ? { networkApprovalContext: { host: 'example.com', protocol: 'https' } }
          : { command: 'printf "你好 Codex"', cwd: thread.cwd }),
      },
    };
  thread.status = {
    type: 'active',
    activeFlags:
      kind === 'questions' && options.nonblockingQuestions
        ? []
        : [kind === 'questions' ? 'waitingOnUserInput' : 'waitingOnApproval'],
  };
  notify({
    method: 'thread/status/changed',
    params: { threadId: thread.id, status: thread.status },
  });
  send(request);
  callbacks.set(id, () => {
    notify({ method: 'serverRequest/resolved', params: { threadId: thread.id, requestId: id } });
    thread.status = { type: 'active', activeFlags: [] };
    execute(thread, turn);
  });
}
const model: Model = {
  id: 'simulated-model',
  model: 'simulated-model',
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: '模拟模型',
  description: '仅供自动测试，不发起真实推理',
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Low' },
    { reasoningEffort: 'medium', description: 'Medium' },
    { reasoningEffort: 'high', description: 'High' },
  ],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text'],
  supportsPersonality: false,
  multiAgentVersion: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  availableAccessPrograms: null,
  isDefault: true,
};
function receive(request: ClientRequest): void {
  if (request.method === 'initialize') {
    initialized = true;
    reply(request.id, {
      userAgent: 'codex/0.162.1',
      codexHome: '/tmp/simulated-codex',
      platformFamily: 'unix',
      platformOs: 'macos',
    } satisfies InitializeResponse);
    return;
  }
  if (!initialized || !handshaken) {
    error(request.id, 'Handshake incomplete', -32000);
    return;
  }
  if (request.method === options.unsupportedMethod) {
    error(request.id, 'Method not found', -32601);
    return;
  }
  switch (request.method) {
    case 'account/read':
      reply(request.id, { account: null, requiresOpenaiAuth: false });
      break;
    case 'model/list':
      reply(request.id, { data: [model], nextCursor: null });
      break;
    case 'thread/start': {
      const thread = makeThread(request.params.cwd ?? process.cwd());
      threads.set(thread.id, thread);
      notify({ method: 'thread/started', params: { thread: { ...thread, turns: [] } } });
      reply(request.id, startResponse(thread));
      break;
    }
    case 'thread/list':
      reply(request.id, {
        data: [...threads.values()]
          .filter((thread) => !request.params.cwd || thread.cwd === request.params.cwd)
          .map((thread) => ({ ...thread, turns: [] })),
        nextCursor: null,
      });
      break;
    case 'thread/read': {
      const thread = threads.get(request.params.threadId);
      if (!thread) {
        error(request.id, 'Thread not found');
        break;
      }
      if (options.forkHistoryReadError && thread.forkedFromId) {
        error(request.id, 'Fork history temporarily unavailable', -32000);
        break;
      }
      reply(request.id, {
        thread: { ...thread, turns: request.params.includeTurns ? thread.turns : [] },
      });
      break;
    }
    case 'thread/fork': {
      const source = threads.get(request.params.threadId);
      if (!source) {
        error(request.id, 'Thread not found');
        break;
      }
      const thread = {
        ...makeThread(request.params.cwd ?? source.cwd),
        forkedFromId: source.id,
        preview: source.preview,
        name: source.name,
        turns: structuredClone(source.turns),
      };
      for (const turn of thread.turns) {
        if (turn.status === 'inProgress') {
          turn.status = 'interrupted';
          turn.completedAt = Date.now() / 1000;
        }
      }
      threads.set(thread.id, thread);
      notify({ method: 'thread/started', params: { thread: { ...thread, turns: [] } } });
      reply(request.id, {
        ...startResponse(thread),
        thread: options.malformedForkReceipt
          ? { id: thread.id, status: { type: 'futureStatus' }, cwd: thread.cwd, turns: [] }
          : { ...thread, turns: request.params.excludeTurns ? [] : thread.turns },
      });
      break;
    }
    case 'thread/resume': {
      const thread = threads.get(request.params.threadId);
      if (!thread) {
        error(request.id, 'Thread not found');
        break;
      }
      reply(request.id, {
        ...startResponse(thread),
        collaborationMode: null,
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      });
      break;
    }
    case 'thread/turns/list': {
      const turns = threads.get(request.params.threadId)?.turns ?? [];
      const offset = Number(request.params.cursor ?? 0);
      const limit = options.historyPageSize ?? turns.length;
      reply(request.id, {
        data: turns
          .slice(offset, offset + limit)
          .map((turn) =>
            options.historyItemSummaries ? { ...turn, items: [], itemsView: 'summary' } : turn,
          ),
        nextCursor: offset + limit < turns.length ? String(offset + limit) : null,
        backwardsCursor: null,
      });
      break;
    }
    case 'thread/items/list': {
      const turn = threads
        .get(request.params.threadId)
        ?.turns.find((entry) => entry.id === request.params.turnId);
      const items = turn?.items ?? [];
      const offset = Number(request.params.cursor ?? 0);
      const limit = options.historyPageSize ?? items.length;
      reply(request.id, {
        data: items.slice(offset, offset + limit).map((item) => ({
          turnId: request.params.turnId,
          item,
          startedAtMs: null,
          completedAtMs: null,
        })),
        nextCursor: offset + limit < items.length ? String(offset + limit) : null,
        backwardsCursor: null,
      });
      break;
    }
    case 'turn/start': {
      const thread = threads.get(request.params.threadId);
      if (!thread) {
        error(request.id, 'Thread not found');
        break;
      }
      if (thread.status.type === 'active') {
        error(request.id, 'Thread busy');
        break;
      }
      if (options.crashAfterDispatch) {
        process.exit(17);
      }
      if (options.malformed) {
        process.stdout.write('{invalid json\n');
        break;
      }
      if (options.hugeLineBytes) {
        process.stdout.write('x'.repeat(options.hugeLineBytes));
        break;
      }
      const input: ThreadItem = {
        id: randomUUID(),
        type: 'userMessage',
        clientId: null,
        content: request.params.input,
      };
      const turn: Turn = {
        id: randomUUID(),
        rootTurnId: null,
        items: [input],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: Date.now() / 1000,
        completedAt: null,
        durationMs: null,
      };
      thread.turns.push(turn);
      thread.status = { type: 'active', activeFlags: [] };
      thread.preview = request.params.input
        .flatMap((input) => (input.type === 'text' ? input.text : ''))
        .join('');
      notify({ method: 'turn/started', params: { threadId: thread.id, turn } });
      const receipt = structuredClone(turn);
      setTimeout(
        () =>
          reply(request.id, {
            turn: options.malformedTurnReceipt
              ? { id: receipt.id, status: 'newUnknownStatus', items: [] }
              : receipt,
          }),
        options.ackDelayMs ?? 0,
      );
      const prompt = thread.preview.toLowerCase();
      const kind =
        options.approval ??
        (prompt.includes('[questions]')
          ? 'questions'
          : prompt.includes('[file-approval]')
            ? 'file'
            : prompt.includes('[network]')
              ? 'network'
              : prompt.includes('[approval]')
                ? 'command'
                : undefined);
      if (kind) approval(thread, turn, kind);
      else execute(thread, turn);
      break;
    }
    case 'turn/steer': {
      const thread = threads.get(request.params.threadId);
      const turn = thread?.turns.find((entry) => entry.id === request.params.expectedTurnId);
      if (!turn || turn.status !== 'inProgress') {
        error(request.id, 'Turn no longer active');
        break;
      }
      const item: ThreadItem = {
        id: randomUUID(),
        type: 'userMessage',
        clientId: null,
        content: request.params.input,
      };
      turn.items.push(item);
      notify({
        method: 'item/completed',
        params: { threadId: thread!.id, turnId: turn.id, item, completedAtMs: Date.now() },
      });
      reply(request.id, { turnId: turn.id });
      break;
    }
    case 'turn/interrupt': {
      const thread = threads.get(request.params.threadId);
      const turn = thread?.turns.find((entry) => entry.id === request.params.turnId);
      if (thread && turn) complete(thread, turn, 'interrupted');
      reply(request.id, {});
      break;
    }
    default:
      error(request.id, 'Method not found', -32601);
  }
}
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (options.logPath) appendFileSync(options.logPath, line + '\n');
  const message = JSON.parse(line) as
    | ClientRequest
    | { method: 'initialized' }
    | { id: RequestId; result?: unknown; error?: unknown };
  if ('method' in message && message.method === 'initialized') {
    handshaken = true;
    return;
  }
  if (!('method' in message)) {
    const callback = callbacks.get(message.id);
    callbacks.delete(message.id);
    callback?.();
    return;
  }
  receive(message);
});
input.on('close', () => {
  for (const timer of finishes.values()) clearTimeout(timer);
  void writes.then(() => process.exit(0));
});
