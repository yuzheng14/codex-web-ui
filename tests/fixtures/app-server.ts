/** Explicit test process. Its envelopes and payloads use the CLI-generated 0.162.1 protocol. */
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { ClientRequest } from '../../src/codex/generated/ClientRequest.js';
import type { ServerNotification } from '../../src/codex/generated/ServerNotification.js';
import type { ServerRequest } from '../../src/codex/generated/ServerRequest.js';
import type { ReasoningEffort } from '../../src/codex/generated/ReasoningEffort.js';
import type { ThreadStartParams } from '../../src/codex/generated/v2/ThreadStartParams.js';
import type { Thread } from '../../src/codex/generated/v2/Thread.js';
import type { Turn } from '../../src/codex/generated/v2/Turn.js';
import type { ThreadItem } from '../../src/codex/generated/v2/ThreadItem.js';
import type { Model } from '../../src/codex/generated/v2/Model.js';
import type { ThreadStartResponse } from '../../src/codex/generated/v2/ThreadStartResponse.js';
import type { InitializeResponse } from '../../src/codex/generated/InitializeResponse.js';
import type { RequestId } from '../../src/codex/generated/RequestId.js';
import type { RequestPermissionProfile } from '../../src/codex/generated/v2/RequestPermissionProfile.js';
import type { McpElicitationSchema } from '../../src/codex/generated/v2/McpElicitationSchema.js';
import type { JsonValue } from '../../src/codex/generated/serde_json/JsonValue.js';
import type { GuardianApprovalReviewStatus } from '../../src/codex/generated/v2/GuardianApprovalReviewStatus.js';

export interface SimulatorOptions {
  configModel?: string | null;
  configEffort?: ReasoningEffort | null;
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
  resumeFailure?: { code: number; message: string };
  approval?:
    | 'command'
    | 'file'
    | 'network'
    | 'questions'
    | 'unsupported'
    | 'permissions'
    | 'elicitation-form'
    | 'elicitation-url'
    | 'elicitation-openai'
    | 'elicitation-openai-form'
    | 'elicitation-malformed';
  permissions?: RequestPermissionProfile;
  elicitationSchema?: unknown;
  elicitationTurnId?: null;
  malformed?: boolean;
  hugeLineBytes?: number;
  malformedTurnReceipt?: boolean;
  nonblockingQuestions?: boolean;
  threadNames?: string[];
  titleOutput?: string;
  titleOutputs?: string[];
  accountType?: 'chatgpt' | 'apiKey';
  models?: string[];
  modelProvider?: string;
  activePermissionProfile?: string;
  temporaryPermissionProfile?: string;
  userMessageDelayMs?: number;
  titleDelayMs?: number;
  threadStartedDelayMs?: number;
  titleBehavior?: 'fail' | 'hang' | 'rename' | 'interaction';
  autoReview?: Exclude<GuardianApprovalReviewStatus, 'inProgress'> | 'unfinished';
  autoReviewDelayMs?: number;
}
const optionsIndex = process.argv.indexOf('--options');
const options = JSON.parse(
  optionsIndex < 0 ? '{}' : (process.argv[optionsIndex + 1] ?? '{}'),
) as SimulatorOptions;
const threads = new Map<string, Thread>();
const policies = new Map<
  string,
  Pick<ThreadStartResponse, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'>
>();
const finishes = new Map<string, NodeJS.Timeout>();
type ServerReply = { id: RequestId; result?: unknown; error?: unknown };
const callbacks = new Map<RequestId, (response: ServerReply) => void>();
let initialized = false;
let handshaken = false;
let nextRequestId = 0;
let titleAttempts = 0;
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
    modelProvider: options.modelProvider ?? 'openai',
    model: 'simulated-model',
    reasoningEffort: cwd.endsWith('other-project') ? 'high' : 'medium',
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
function policy(thread: Thread) {
  return (
    policies.get(thread.id) ?? {
      approvalPolicy: 'on-request' as const,
      approvalsReviewer: 'user' as const,
      sandbox: { type: 'readOnly' as const, networkAccess: false },
    }
  );
}
function startResponse(
  thread: Thread,
): ThreadStartResponse & { activePermissionProfile?: { id: string } } {
  return {
    thread,
    model: thread.model ?? 'simulated-model',
    modelProvider: thread.modelProvider,
    serviceTier: null,
    disabledPluginIds: [],
    cwd: thread.cwd,
    instructionSources: [],
    ...policy(thread),
    reasoningEffort: thread.reasoningEffort,
    ...(options.activePermissionProfile
      ? {
          activePermissionProfile: {
            id: thread.ephemeral
              ? (options.temporaryPermissionProfile ?? options.activePermissionProfile)
              : options.activePermissionProfile,
          },
        }
      : {}),
  };
}
function applySettings(
  thread: Thread,
  settings: Pick<ThreadStartParams, 'model' | 'config' | 'sandbox' | 'approvalPolicy'>,
) {
  if (settings.model) thread.model = settings.model;
  const effort = settings.config?.model_reasoning_effort;
  if (typeof effort === 'string') thread.reasoningEffort = effort as ReasoningEffort;
  const current = policy(thread);
  if (settings.approvalPolicy) current.approvalPolicy = settings.approvalPolicy;
  if (settings.sandbox)
    current.sandbox =
      settings.sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : settings.sandbox === 'read-only'
          ? { type: 'readOnly', networkAccess: false }
          : {
              type: 'workspaceWrite',
              writableRoots: [thread.cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            };
  policies.set(thread.id, current);
}
function notifySettings(thread: Thread) {
  notify({
    method: 'thread/settings/updated',
    params: {
      threadId: thread.id,
      threadSettings: {
        disabledPluginIds: [],
        cwd: thread.cwd,
        approvalPolicy: policy(thread).approvalPolicy,
        approvalsReviewer: policy(thread).approvalsReviewer,
        sandboxPolicy: policy(thread).sandbox,
        activePermissionProfile: null,
        model: thread.model!,
        modelProvider: thread.modelProvider,
        serviceTier: null,
        effort: thread.reasoningEffort,
        summary: null,
        personality: null,
        collaborationMode: {
          mode: 'default',
          settings: {
            model: thread.model!,
            reasoning_effort: thread.reasoningEffort,
            developer_instructions: null,
          },
        },
      },
    },
  });
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
  status: 'completed' | 'interrupted' | 'failed' = 'completed',
): void {
  clearTimeout(finishes.get(turn.id));
  finishes.delete(turn.id);
  if (turn.status !== 'inProgress') return;
  turn.status = status;
  turn.completedAt = Date.now() / 1000;
  thread.status = { type: 'idle' };
  // Explicit test prompt: retain real terminal history while dropping its notification.
  if (
    !turn.items.some(
      (item) =>
        item.type === 'userMessage' &&
        item.content.some(
          (input) => input.type === 'text' && input.text.includes('[miss-completion]'),
        ),
    )
  )
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
function execute(thread: Thread, turn: Turn, cmd = command(randomUUID(), thread.cwd)): void {
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
function codexReconnect(thread: Thread, turn: Turn, outcome: 'recover' | 'fail' | 'hold'): void {
  const cmd = command(randomUUID(), thread.cwd);
  cmd.command = '读取已有任务的后台输出';
  turn.items.push(cmd);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item: cmd, startedAtMs: Date.now() },
  });
  const retry = (attempt: number) =>
    notify({
      method: 'error',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        willRetry: true,
        error: {
          message: `Reconnecting... ${attempt}/5 (stream disconnected before completion)`,
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          additionalDetails: null,
          misalignment: null,
        },
      },
    });
  const later = (delay: number, work: () => void) =>
    setTimeout(() => {
      // An interrupted turn must never be revived by a queued simulator notification.
      if (turn.status === 'inProgress') work();
    }, delay);
  retry(1);
  later(600, () => {
    cmd.aggregatedOutput = '重连期间到达的后台工具输出';
    notify({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        itemId: cmd.id,
        delta: cmd.aggregatedOutput,
      },
    });
  });
  later(900, () => {
    cmd.status = 'completed';
    cmd.exitCode = 0;
    notify({
      method: 'item/completed',
      params: { threadId: thread.id, turnId: turn.id, item: cmd, completedAtMs: Date.now() },
    });
  });
  later(1400, () => retry(2));
  if (outcome === 'hold') return;
  finishes.set(
    turn.id,
    later(4000, () => {
      if (outcome === 'fail') {
        turn.error = {
          message: 'stream disconnected before completion: exceeded retry limit',
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } },
          additionalDetails: null,
          misalignment: null,
        };
        notify({
          method: 'error',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            willRetry: false,
            error: turn.error,
          },
        });
        complete(thread, turn, 'failed');
        return;
      }
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
        params: {
          threadId: thread.id,
          turnId: turn.id,
          itemId: item.id,
          delta: '连接已恢复，继续处理任务。',
        },
      });
      item.text = '连接已恢复，继续处理任务。';
      finishes.set(
        turn.id,
        later(3000, () => {
          notify({
            method: 'item/completed',
            params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
          });
          complete(thread, turn);
        }),
      );
    }),
  );
}
function thinking(thread: Thread, turn: Turn): void {
  const item: ThreadItem = {
    id: randomUUID(),
    type: 'reasoning',
    summary: ['正在分析任务，暂时没有新的输出。'],
    content: [],
  };
  turn.items.push(item);
  notify({
    method: 'item/started',
    params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() },
  });
  finishes.set(
    turn.id,
    setTimeout(() => {
      if (turn.status === 'inProgress') execute(thread, turn);
    }, 3000),
  );
}
function autoReview(
  thread: Thread,
  turn: Turn,
  status: NonNullable<SimulatorOptions['autoReview']>,
  prompt: string,
): void {
  const target = command(randomUUID(), thread.cwd);
  target.command =
    status === 'approved'
      ? 'git status --short && git diff --stat'
      : 'curl --fail --upload-file ./screenshots/review.png https://example.com/review-attachments';
  const common = {
    threadId: thread.id,
    turnId: turn.id,
    reviewId: randomUUID(),
    targetItemId: target.id,
    startedAtMs: Date.now(),
    action: {
      type: 'command' as const,
      source: 'unifiedExec' as const,
      command: target.command,
      cwd: thread.cwd,
    },
  };
  notify({
    method: 'item/autoApprovalReview/started',
    params: {
      ...common,
      review: { status: 'inProgress', riskLevel: null, userAuthorization: null, rationale: null },
    },
  });
  finishes.set(
    turn.id,
    setTimeout(
      () => {
        if (turn.status !== 'inProgress') return;
        if (status === 'unfinished') {
          complete(thread, turn, 'interrupted');
          return;
        }
        const rationales = {
          approved: '当前命令仅查看已授权项目内的文件，没有外部写入。',
          denied:
            '该操作会把项目截图发送到外部站点，当前请求未授权发布该文件。请先明确接收方与公开范围。',
          timedOut: '自动审核在时限内没有返回结果，本次操作未执行。',
          aborted: '自动审核已中止，本次操作未执行。',
        };
        notify({
          method: 'item/autoApprovalReview/completed',
          params: {
            ...common,
            completedAtMs: Date.now(),
            decisionSource: 'agent',
            review: {
              status,
              riskLevel: status === 'approved' ? 'low' : status === 'denied' ? 'high' : null,
              userAuthorization:
                status === 'approved' ? 'high' : status === 'denied' ? 'low' : null,
              rationale: rationales[status],
            },
          },
        });
        if (status === 'approved') execute(thread, turn, target);
        else complete(thread, turn, 'interrupted');
      },
      options.autoReviewDelayMs ?? (prompt.includes('[auto-review-slow]') ? 4000 : 1500),
    ),
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
  else if (kind === 'permissions')
    request = {
      id,
      method: 'item/permissions/requestApproval',
      params: {
        ...common,
        environmentId: null,
        startedAtMs: Date.now(),
        cwd: thread.cwd,
        reason: '需要联网并保存截图附件，请确认权限范围。',
        permissions: options.permissions ?? {
          network: { enabled: true },
          fileSystem: {
            read: [`${thread.cwd}/reference`],
            write: [`${thread.cwd}/report.txt`],
            globScanMaxDepth: 2,
            entries: [
              { path: { type: 'path', path: `${thread.cwd}/screenshots` }, access: 'write' },
            ],
          },
        },
      },
    };
  else if (kind.startsWith('elicitation-')) {
    const context = {
      threadId: thread.id,
      turnId: options.elicitationTurnId === null ? null : turn.id,
      serverName: '截图发布服务',
      _meta: null,
      message: '请确认截图发布设置，只有提交后任务才会继续。',
    };
    const schema =
      options.elicitationSchema ??
      (kind === 'elicitation-malformed'
        ? { type: 'object', properties: { nested: { type: 'object', properties: {} } } }
        : {
            type: 'object',
            properties: {
              project: { type: 'string', title: '项目名称', minLength: 2, maxLength: 60 },
              retries: { type: 'integer', title: '重试次数', minimum: 0, maximum: 5 },
              rating: { type: 'number', title: '评分', minimum: 0, maximum: 10 },
              notify: { type: 'boolean', title: '启用通知' },
              environment: {
                type: 'string',
                title: '环境',
                oneOf: [
                  { const: 'production', title: '生产' },
                  { const: 'preview', title: '预览' },
                ],
              },
              channels: {
                type: 'array',
                title: '发布渠道',
                minItems: 1,
                maxItems: 2,
                items: {
                  anyOf: [
                    { const: 'web', title: '网页' },
                    { const: 'mobile', title: '移动端' },
                  ],
                },
              },
              note: { type: 'string', title: '备注' },
            },
            required: ['project', 'retries', 'rating', 'notify', 'environment', 'channels'],
          });
    request = {
      id,
      method: 'mcpServer/elicitation/request',
      params:
        kind === 'elicitation-url'
          ? {
              ...context,
              mode: 'url',
              url: 'https://example.com/authorize?service=screenshots',
              elicitationId: `elicitation-${id}`,
            }
          : kind === 'elicitation-openai'
            ? { ...context, mode: 'openai/form', requestedSchema: schema as JsonValue }
            : kind === 'elicitation-openai-form'
              ? { ...context, mode: 'openaiForm', requestedSchema: schema as JsonValue }
              : { ...context, mode: 'form', requestedSchema: schema as McpElicitationSchema },
    };
  } else if (kind === 'file')
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
        : [
            kind === 'questions' || kind.startsWith('elicitation-')
              ? 'waitingOnUserInput'
              : 'waitingOnApproval',
          ],
  };
  notify({
    method: 'thread/status/changed',
    params: { threadId: thread.id, status: thread.status },
  });
  send(request);
  callbacks.set(id, (response) => {
    notify({ method: 'serverRequest/resolved', params: { threadId: thread.id, requestId: id } });
    thread.status = { type: 'active', activeFlags: [] };
    if (kind === 'permissions' || kind.startsWith('elicitation-')) {
      const result = response.result as Record<string, unknown> | undefined;
      const accepted =
        kind === 'permissions'
          ? result?.permissions && Object.keys(result.permissions).length > 0
          : result?.action === 'accept';
      if (!accepted || response.error) {
        complete(thread, turn, 'interrupted');
        return;
      }
    }
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
    { reasoningEffort: 'none', description: 'None' },
    { reasoningEffort: 'minimal', description: 'Minimal' },
    { reasoningEffort: 'low', description: 'Low' },
    { reasoningEffort: 'medium', description: 'Medium' },
    { reasoningEffort: 'high', description: 'High' },
    { reasoningEffort: 'xhigh', description: 'Extra high' },
    { reasoningEffort: 'max', description: 'Maximum' },
    { reasoningEffort: 'ultra', description: 'Ultra' },
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
      reply(request.id, {
        account:
          options.accountType === 'chatgpt'
            ? { type: 'chatgpt', email: null, planType: 'plus' }
            : options.accountType === 'apiKey'
              ? { type: 'apiKey' }
              : null,
        requiresOpenaiAuth: false,
      });
      break;
    case 'config/read':
      reply(request.id, {
        config: {
          mcp_servers: { 'fixture.tools': { command: 'unused', enabled: true } },
          model: options.configModel === undefined ? 'simulated-model' : options.configModel,
          model_reasoning_effort:
            options.configEffort === undefined
              ? request.params.cwd?.endsWith('other-project')
                ? 'high'
                : 'medium'
              : options.configEffort,
          sandbox_mode: 'read-only',
          approval_policy: 'on-request',
          approvals_reviewer: 'user',
          developer_instructions: 'private instructions',
          api_key: 'private-test-key',
        },
        origins: {},
        layers: null,
      });
      break;
    case 'model/list':
      reply(request.id, {
        data: (options.models ?? [model.model]).map((name) => ({
          ...model,
          id: name,
          model: name,
        })),
        nextCursor: null,
      });
      break;
    case 'thread/start': {
      const thread = makeThread(request.params.cwd ?? process.cwd());
      thread.ephemeral = request.params.ephemeral ?? false;
      thread.modelProvider = request.params.modelProvider ?? thread.modelProvider;
      applySettings(thread, request.params);
      threads.set(thread.id, thread);
      const started = () =>
        notify({ method: 'thread/started', params: { thread: { ...thread, turns: [] } } });
      if (options.threadStartedDelayMs) setTimeout(started, options.threadStartedDelayMs);
      else started();
      reply(request.id, startResponse(thread));
      break;
    }
    case 'thread/list':
      reply(request.id, {
        data: [...threads.values()]
          .filter((thread) => !thread.ephemeral)
          .filter((thread) => !request.params.cwd || thread.cwd === request.params.cwd)
          .map((thread) => ({ ...thread, turns: [] })),
        nextCursor: null,
      });
      break;
    case 'thread/name/set': {
      const thread = threads.get(request.params.threadId);
      if (!thread) {
        error(request.id, 'Thread not found');
        break;
      }
      thread.name = request.params.name;
      notify({
        method: 'thread/name/updated',
        params: { threadId: thread.id, threadName: thread.name },
      });
      reply(request.id, {});
      break;
    }
    case 'thread/unsubscribe': {
      const thread = threads.get(request.params.threadId);
      reply(request.id, { status: 'unsubscribed' });
      if (thread?.ephemeral) {
        threads.delete(thread.id);
        notify({ method: 'thread/closed', params: { threadId: thread.id } });
      }
      break;
    }
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
      applySettings(thread, request.params);
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
      if (options.resumeFailure) {
        error(
          request.id,
          options.resumeFailure.message.replaceAll('{threadId}', thread.id),
          options.resumeFailure.code,
        );
        break;
      }
      applySettings(thread, request.params);
      notify({
        method: 'thread/status/changed',
        params: { threadId: thread.id, status: thread.status },
      });
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
      if (request.params.model) thread.model = request.params.model;
      if (request.params.effort) thread.reasoningEffort = request.params.effort;
      const current = policy(thread);
      if (request.params.sandboxPolicy) current.sandbox = request.params.sandboxPolicy;
      if (request.params.approvalPolicy) current.approvalPolicy = request.params.approvalPolicy;
      policies.set(thread.id, current);
      notifySettings(thread);
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
      thread.model = request.params.model ?? thread.model;
      thread.cwd = request.params.cwd ?? thread.cwd;
      thread.status = { type: 'active', activeFlags: [] };
      const text = request.params.input
        .flatMap((input) => (input.type === 'text' ? input.text : ''))
        .join('');
      if (!thread.preview) thread.preview = text;
      notify({ method: 'turn/started', params: { threadId: thread.id, turn } });
      const name = thread.ephemeral ? undefined : options.threadNames?.[thread.turns.length - 1];
      if (name !== undefined) {
        thread.name = name || null;
        notify({
          method: 'thread/name/updated',
          params: { threadId: thread.id, threadName: name || undefined },
        });
      }
      const acceptedInput = () =>
        notify({
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item: input, completedAtMs: Date.now() },
        });
      if (options.userMessageDelayMs && !thread.ephemeral)
        setTimeout(acceptedInput, options.userMessageDelayMs);
      else acceptedInput();
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
      const prompt = text.toLowerCase();
      if (thread.ephemeral) {
        const titleOutput = options.titleOutputs?.[titleAttempts++] ?? options.titleOutput;
        if (options.titleBehavior === 'hang') break;
        if (options.titleBehavior === 'interaction') {
          approval(thread, turn, 'command');
          break;
        }
        if (options.titleBehavior === 'rename') {
          const original = [...threads.values()].find((entry) => !entry.ephemeral);
          if (original) {
            original.name = '用户手动命名';
            notify({
              method: 'thread/name/updated',
              params: { threadId: original.id, threadName: original.name },
            });
          }
        }
        finishes.set(
          turn.id,
          setTimeout(
            () => {
              const item: ThreadItem = {
                id: randomUUID(),
                type: 'agentMessage',
                phase: 'final_answer',
                memoryCitation: null,
                delivery: null,
                questions: null,
                text: titleOutput ?? JSON.stringify({ title: 'Codex 配置继承与运行设置' }),
              };
              notify({
                method: 'item/completed',
                params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() },
              });
              // Real turn/completed notifications may omit items; the completed item carries the answer.
              complete(
                thread,
                turn,
                options.titleBehavior === 'fail' || prompt.includes('[title-fail]')
                  ? 'failed'
                  : 'completed',
              );
            },
            prompt.includes('[title-fail]') ? 10 : (options.titleDelayMs ?? 50),
          ),
        );
        break;
      }
      const interactive = [
        'permissions',
        'unsupported',
        'elicitation-form',
        'elicitation-url',
        'elicitation-openai',
        'elicitation-openai-form',
        'elicitation-malformed',
      ] as const;
      const kind =
        options.approval ??
        interactive.find((candidate) => prompt.includes(`[${candidate}]`)) ??
        (prompt.includes('[questions]')
          ? 'questions'
          : prompt.includes('[file-approval]')
            ? 'file'
            : prompt.includes('[network]')
              ? 'network'
              : prompt.includes('[approval]')
                ? 'command'
                : undefined);
      const reviewStatus =
        options.autoReview ??
        (prompt.includes('[auto-review-denied]')
          ? 'denied'
          : prompt.includes('[auto-review-approved]')
            ? 'approved'
            : prompt.includes('[auto-review-timeout]')
              ? 'timedOut'
              : prompt.includes('[auto-review-aborted]')
                ? 'aborted'
                : prompt.includes('[auto-review-unknown]')
                  ? 'unfinished'
                  : undefined);
      const reconnect = (['recover', 'fail', 'hold'] as const).find((outcome) =>
        prompt.includes(`[codex-retry-${outcome}]`),
      );
      if (reconnect) codexReconnect(thread, turn, reconnect);
      else if (prompt.includes('[codex-thinking]')) thinking(thread, turn);
      else if (reviewStatus) autoReview(thread, turn, reviewStatus, prompt);
      else if (kind) approval(thread, turn, kind);
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
    callback?.(message);
    return;
  }
  receive(message);
});
input.on('close', () => {
  for (const timer of finishes.values()) clearTimeout(timer);
  void writes.then(() => process.exit(0));
});
