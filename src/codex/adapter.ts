import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ThreadTitles } from './thread-titles.js';
import { AppError } from '../shared/errors.js';
import { mapAutoReview } from './auto-review.js';
import {
  normalizeElicitationRequest,
  validateElicitationResolution,
  validatePermissionResolution,
} from '../shared/elicitation.js';
import type {
  ActionResolution,
  RuntimeSettings,
  PendingAction,
  Settings,
  ThreadPage,
  ThreadView,
  TurnView,
} from '../shared/types.js';
import type { ClientRequest } from './generated/ClientRequest.js';
import type { ServerNotification } from './generated/ServerNotification.js';
import type { ServerRequest } from './generated/ServerRequest.js';
import type { InitializeResponse } from './generated/InitializeResponse.js';
import type { GetAccountResponse } from './generated/v2/GetAccountResponse.js';
import type { ModelListResponse } from './generated/v2/ModelListResponse.js';
import type { ConfigReadResponse } from './generated/v2/ConfigReadResponse.js';
import type { ThreadListResponse } from './generated/v2/ThreadListResponse.js';
import type { ThreadReadResponse } from './generated/v2/ThreadReadResponse.js';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse.js';
import type { ThreadForkResponse } from './generated/v2/ThreadForkResponse.js';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse.js';
import type { ThreadTurnsListResponse } from './generated/v2/ThreadTurnsListResponse.js';
import type { ThreadItemsListResponse } from './generated/v2/ThreadItemsListResponse.js';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse.js';
import type { TurnSteerResponse } from './generated/v2/TurnSteerResponse.js';
import type { TurnInterruptResponse } from './generated/v2/TurnInterruptResponse.js';
import type { CommandExecutionApprovalDecision } from './generated/v2/CommandExecutionApprovalDecision.js';
import type { CommandExecutionRequestApprovalResponse } from './generated/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from './generated/v2/FileChangeRequestApprovalResponse.js';
import type { ToolRequestUserInputResponse } from './generated/v2/ToolRequestUserInputResponse.js';
import type { PermissionsRequestApprovalResponse } from './generated/v2/PermissionsRequestApprovalResponse.js';
import type { McpServerElicitationRequestResponse } from './generated/v2/McpServerElicitationRequestResponse.js';
import type { FileSystemPath } from './generated/v2/FileSystemPath.js';
import {
  mapItem,
  mapThread,
  mapTurn,
  permissionSettings,
  threadSettings,
  threadStatus,
  turnSettings,
  taskInput,
} from './mapping.js';
import {
  asCodexError,
  CodexError,
  isRecord,
  RpcTransport,
  type RpcId,
  type RpcNotification,
  type RpcServerRequest,
} from './transport.js';
import type { CodexClient, CodexDiagnostics, CodexEvent } from './types.js';
export type {
  CodexClient,
  CodexDiagnostics,
  CodexEvent,
  CodexEvent as AdapterEvent,
} from './types.js';
export { CodexError } from './transport.js';

export const VERIFIED_CODEX_VERSION = '0.162.1';
const CAPABILITIES = [
  'thread/start',
  'thread/fork',
  'thread/read',
  'thread/list',
  'thread/resume',
  'thread/turns/list',
  'thread/items/list',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'model/list',
  'config/read',
  'account/read',
];
type Responses = {
  initialize: InitializeResponse;
  'account/read': GetAccountResponse;
  'model/list': ModelListResponse;
  'config/read': ConfigReadResponse;
  'thread/list': ThreadListResponse;
  'thread/read': ThreadReadResponse;
  'thread/start': ThreadStartResponse;
  'thread/fork': ThreadForkResponse;
  'thread/resume': ThreadResumeResponse;
  'thread/turns/list': ThreadTurnsListResponse;
  'thread/items/list': ThreadItemsListResponse;
  'turn/start': TurnStartResponse;
  'turn/steer': TurnSteerResponse;
  'turn/interrupt': TurnInterruptResponse;
};
export interface CodexAdapterOptions {
  binary: string;
  home?: string;
  /** Explicit argument override for the test simulator; production leaves this unset. */
  args?: string[];
  requestTimeoutMs?: number;
  titleTimeoutMs?: number;
  maxLineBytes?: number;
  maxStderrBytes?: number;
}
type ActionContext = {
  action: PendingAction;
  request: ServerRequest;
  decisions: Map<string, CommandExecutionApprovalDecision>;
  responding: boolean;
};

function permissionPathLabel(path: FileSystemPath): string {
  if (path.type === 'path') return path.path;
  if (path.type === 'glob_pattern') return `匹配：${path.pattern}`;
  const special = path.value;
  const subpath =
    'subpath' in special && special.subpath !== null ? `（子路径：${special.subpath}）` : '';
  switch (special.kind) {
    case 'root':
      return '整个文件系统（/）';
    case 'minimal':
      return '系统基础运行目录';
    case 'project_roots':
      return `项目根目录${subpath}`;
    case 'tmpdir':
      return '系统临时目录（TMPDIR）';
    case 'slash_tmp':
      return '/tmp';
    case 'unknown':
      return `特殊路径：${special.path}${subpath}`;
  }
}

export class CodexAdapter implements CodexClient {
  epoch = randomUUID();
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: RpcTransport;
  private titles?: ThreadTitles;
  private listeners = new Set<(event: CodexEvent) => void>();
  private actions = new Map<string, ActionContext>();
  private actionIds = new Map<RpcId, string>();
  private stderrTail = Buffer.alloc(0);
  private disabled = new Set<string>();
  private state: CodexDiagnostics = {
    ready: false,
    connection: 'starting',
    codexVersion: null,
    verifiedVersion: VERIFIED_CODEX_VERSION,
    compatibility: 'unavailable',
    codexEpoch: this.epoch,
    authenticated: null,
    models: [],
    capabilities: [],
  };
  constructor(private readonly options: CodexAdapterOptions) {}
  get pid(): number | undefined {
    return this.child?.pid;
  }
  get ready(): boolean {
    return this.state.ready;
  }
  diagnostics(): CodexDiagnostics {
    return structuredClone(this.state);
  }
  onEvent(listener: (event: CodexEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: CodexEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  private publishRuntime(): void {
    this.emit({ type: 'runtime', diagnostics: this.diagnostics() });
  }

  async start(): Promise<void> {
    if (this.child) throw new CodexError('CODEX_BUSY', 'Codex app-server is already started');
    this.epoch = randomUUID();
    this.disabled.clear();
    this.state = {
      ...this.state,
      codexEpoch: this.epoch,
      ready: false,
      connection: 'starting',
      error: undefined,
      capabilities: [],
    };
    this.publishRuntime();
    try {
      const env = {
        ...process.env,
        ...(this.options.home === undefined ? {} : { CODEX_HOME: this.options.home }),
      };
      const { stdout } = await promisify(execFile)(this.options.binary, ['--version'], {
        env,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      const version = stdout.trim().replace(/^codex-cli\s+/, '');
      this.state.codexVersion = version;
      this.state.compatibility = version === VERIFIED_CODEX_VERSION ? 'verified' : 'unverified';
      const child = spawn(
        this.options.binary,
        this.options.args ?? ['app-server', '--listen', 'stdio://'],
        { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false },
      );
      this.child = child;
      const rpc = new RpcTransport(child.stdin, child.stdout, {
        timeoutMs: this.options.requestTimeoutMs,
        maxLineBytes: this.options.maxLineBytes,
      });
      this.rpc = rpc;
      this.titles = new ThreadTitles(rpc, this.options.titleTimeoutMs);
      child.stderr.on('data', (chunk: Buffer) => {
        const max = this.options.maxStderrBytes ?? 64 * 1024;
        this.stderrTail = Buffer.concat([this.stderrTail, chunk.subarray(-max)]).subarray(-max);
      });
      child.on('error', (error) =>
        rpc.fail(new CodexError('CODEX_UNAVAILABLE', `Cannot start Codex: ${error.message}`, true)),
      );
      child.on('exit', (code, signal) => {
        rpc.fail(
          new CodexError(
            'CODEX_UNAVAILABLE',
            `Codex exited (${signal ?? code ?? 'unknown'})`,
            true,
          ),
        );
        if (this.child === child) this.child = undefined;
      });
      rpc.on('notification', (message: RpcNotification) => {
        try {
          this.notification(message);
        } catch (error) {
          rpc.fail(asCodexError(error));
        }
      });
      rpc.on('request', (message: RpcServerRequest) => {
        void this.serverRequest(message).catch((error: unknown) => rpc.fail(asCodexError(error)));
      });
      rpc.on('failure', (error: CodexError) => {
        if (this.rpc !== rpc) return;
        this.state.ready = false;
        this.state.connection = 'unavailable';
        this.state.error = error.message;
        this.expireActions();
        this.publishRuntime();
        if (!child.killed) child.kill('SIGTERM');
        const kill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2500);
        kill.unref();
        child.once('exit', () => clearTimeout(kill));
      });
      const initialized = await this.call(
        'initialize',
        {
          clientInfo: { name: 'codex_web_ui', title: 'Codex Web UI', version: '0.1.0' },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            explicitGatewayOauth: true,
          },
        },
        true,
      );
      if (!isRecord(initialized) || typeof initialized.userAgent !== 'string')
        throw new CodexError(
          'PROTOCOL_INCOMPATIBLE',
          'Codex initialize returned a malformed result',
          true,
        );
      await rpc.notify('initialized');
      const [account, models] = await Promise.all([
        this.call('account/read', { refreshToken: false }, true),
        this.call('model/list', { limit: 100 }, true),
      ]);
      if (
        !isRecord(account) ||
        !Object.hasOwn(account, 'account') ||
        typeof account.requiresOpenaiAuth !== 'boolean'
      )
        throw new CodexError(
          'PROTOCOL_INCOMPATIBLE',
          'Codex account/read returned a malformed result',
          true,
        );
      this.state.authenticated = account.account !== null || !account.requiresOpenaiAuth;
      this.state.models = models.data.map((model) => ({
        id: model.model,
        name: model.displayName,
        description: model.description,
        reasoningEfforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        defaultReasoningEffort: model.defaultReasoningEffort,
      }));
      let cursor = models.nextCursor;
      const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor) || seen.size >= 100)
          throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid model pagination');
        seen.add(cursor);
        const page = await this.call('model/list', { limit: 100, cursor }, true);
        this.state.models.push(
          ...page.data.map((model) => ({
            id: model.model,
            name: model.displayName,
            description: model.description,
            reasoningEfforts: model.supportedReasoningEfforts.map(
              (effort) => effort.reasoningEffort,
            ),
            defaultReasoningEffort: model.defaultReasoningEffort,
          })),
        );
        cursor = page.nextCursor;
      }
      this.titles?.configure(
        account.account?.type === 'chatgpt',
        this.state.models.map((model) => model.id),
      );
      this.state.ready = true;
      this.state.connection = 'ready';
      this.state.capabilities = CAPABILITIES.filter((method) => !this.disabled.has(method));
      this.publishRuntime();
    } catch (error) {
      const failure = asCodexError(error);
      this.state.ready = false;
      this.state.connection = 'unavailable';
      this.state.error = failure.message;
      this.publishRuntime();
      await this.stop();
      throw failure;
    }
  }
  async stop(): Promise<void> {
    const child = this.child;
    this.state.ready = false;
    this.state.connection = 'unavailable';
    this.expireActions();
    this.rpc?.fail(
      new CodexError('CODEX_UNAVAILABLE', 'Codex connection closed by this service', true),
    );
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const term = setTimeout(() => child.kill('SIGTERM'), 1000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 2500);
      const done = setTimeout(() => {
        cleanup();
        resolve();
      }, 3500);
      const cleanup = () => {
        clearTimeout(term);
        clearTimeout(kill);
        clearTimeout(done);
      };
      child.once('exit', () => {
        cleanup();
        resolve();
      });
    });
    if (this.child === child) this.child = undefined;
  }
  private async call<M extends keyof Responses>(
    method: M,
    params: Extract<ClientRequest, { method: M }>['params'],
    initializing = false,
  ): Promise<Responses[M]> {
    if (!this.rpc || (!initializing && !this.ready))
      throw new CodexError('CODEX_UNAVAILABLE', 'Codex is not ready');
    if (this.disabled.has(method))
      throw new CodexError('PROTOCOL_INCOMPATIBLE', `Codex does not support ${method}`);
    try {
      return await this.rpc.request<Responses[M]>(method, params);
    } catch (error) {
      if (error instanceof CodexError && error.rpcCode === -32601) {
        this.disabled.add(method);
        this.state.capabilities = this.state.capabilities.filter((name) => name !== method);
        this.state.error = `当前 Codex 缺少 ${method} 能力`;
        this.publishRuntime();
      }
      throw error;
    }
  }
  private validateSettings(settings: Settings = {}): void {
    const model =
      settings.model === undefined
        ? undefined
        : this.state.models.find((entry) => entry.id === settings.model);
    if (settings.model !== undefined && !model)
      throw new AppError('VALIDATION_ERROR', '模型不在当前 Codex 模型列表中');
    if (
      settings.reasoningEffort !== undefined &&
      !(
        model?.reasoningEfforts ?? this.state.models.flatMap((entry) => entry.reasoningEfforts)
      ).includes(settings.reasoningEffort)
    )
      throw new AppError('VALIDATION_ERROR', '所选推理强度不受当前模型支持');
  }
  async listThreads(_cwd: string, cursor?: string): Promise<ThreadPage> {
    // Upstream cwd matches exact stored strings, so it would omit symlink aliases
    // and owned subdirectories. The service filters each page using realpath ownership.
    const page = await this.call('thread/list', {
      cursor,
      limit: 30,
      sourceKinds: ['cli', 'appServer', 'vscode'],
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    return { data: page.data.map(mapThread), nextCursor: page.nextCursor };
  }
  async readThreadMetadata(id: string): Promise<ThreadView> {
    return mapThread(
      (await this.call('thread/read', { threadId: id, includeTurns: false })).thread,
    );
  }
  async readThread(id: string): Promise<ThreadView> {
    const { thread } = await this.call('thread/read', { threadId: id, includeTurns: false });
    if (thread.historyMode !== 'paginated')
      return mapThread(
        (await this.call('thread/read', { threadId: id, includeTurns: true })).thread,
      );
    let cursor: string | null = null;
    const seen = new Set<string>();
    thread.turns = [];
    do {
      const page: ThreadTurnsListResponse = await this.call('thread/turns/list', {
        threadId: id,
        cursor,
        limit: 100,
        sortDirection: 'asc',
        itemsView: 'full',
      });
      for (const turn of page.data) {
        if (turn.itemsView !== 'full') {
          let itemCursor: string | null = null;
          const itemSeen = new Set<string>();
          turn.items = [];
          do {
            const items: ThreadItemsListResponse = await this.call('thread/items/list', {
              threadId: id,
              turnId: turn.id,
              cursor: itemCursor,
              limit: 100,
              sortDirection: 'asc',
            });
            turn.items.push(...items.data.map((entry) => entry.item));
            itemCursor = items.nextCursor;
            if (itemCursor && (itemSeen.has(itemCursor) || itemSeen.size >= 1000))
              throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid item pagination');
            if (itemCursor) itemSeen.add(itemCursor);
          } while (itemCursor);
        }
      }
      thread.turns.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 1000))
        throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Invalid turn pagination');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return mapThread(thread);
  }
  async createThread(cwd: string, settings?: Settings): Promise<ThreadView> {
    this.validateSettings(settings);
    const titles = this.titles;
    const result = await this.call('thread/start', { cwd, ...threadSettings(settings) });
    titles?.register(result);
    return { ...mapThread(result.thread), runtimeSettings: this.responseRuntimeSettings(result) };
  }
  async readRuntimeSettings(cwd: string): Promise<RuntimeSettings> {
    const { config } = await this.call('config/read', { cwd, includeLayers: false });
    // Config can contain credentials and instructions. Only displayable fields cross the gateway.
    return {
      model: typeof config.model === 'string' ? config.model : null,
      reasoningEffort:
        typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : null,
      sandbox: config.sandbox_mode ?? null,
      approvalPolicy:
        typeof config.approval_policy === 'string'
          ? config.approval_policy
          : config.approval_policy
            ? 'granular'
            : null,
      approvalReviewer: config.approvals_reviewer ?? null,
    };
  }
  private responseRuntimeSettings(result: ThreadStartResponse): RuntimeSettings {
    return {
      model: result.model ?? result.thread.model ?? null,
      reasoningEffort: result.reasoningEffort ?? null,
      ...permissionSettings(result.sandbox, result.approvalPolicy, result.approvalsReviewer),
    };
  }
  async resumeThread(id: string, cwd: string, settings?: Settings): Promise<ThreadView> {
    this.validateSettings(settings);
    const titles = this.titles;
    let result: ThreadResumeResponse;
    try {
      result = await this.call('thread/resume', {
        threadId: id,
        cwd,
        ...threadSettings(settings),
      });
    } catch (error) {
      // Verified with two 0.162.1 processes, for both legacy and paginated histories.
      // -32600 alone covers many failures; match this thread's writer conflict exactly.
      if (
        error instanceof CodexError &&
        error.rpcCode === -32600 &&
        error.message === `thread ${id} already has an active writer`
      )
        throw new AppError('THREAD_IN_USE', '此会话正被其他进程使用', 409, { threadId: id });
      throw error;
    }
    titles?.register(result);
    const thread = result.thread;
    const view =
      thread.historyMode === 'paginated' ? await this.readThread(thread.id) : mapThread(thread);
    return { ...view, runtimeSettings: this.responseRuntimeSettings(result) };
  }
  async forkThread(id: string, cwd: string, settings?: Settings): Promise<ThreadView> {
    this.validateSettings(settings);
    const titles = this.titles;
    const result = await this.call('thread/fork', {
      threadId: id,
      cwd,
      ...threadSettings(settings),
      // Omitting lastTurnId copies the persisted history, including an active turn's
      // interruption marker in the fork. The source is never resumed or interrupted.
      excludeTurns: true,
    });
    let forkedId: string | undefined;
    try {
      if (isRecord(result) && isRecord(result.thread) && typeof result.thread.id === 'string')
        forkedId = result.thread.id === id ? undefined : result.thread.id;
      const metadata = mapThread(result.thread);
      if (metadata.id === id)
        throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Codex fork returned the source thread ID');
      forkedId = metadata.id;
      const thread = await this.readThread(forkedId);
      if (thread.id !== forkedId)
        throw new CodexError('PROTOCOL_INCOMPATIBLE', 'Codex returned a different fork thread ID');
      titles?.register(result);
      return { ...thread, runtimeSettings: this.responseRuntimeSettings(result) };
    } catch (error) {
      const failure = asCodexError(error);
      // The mutating RPC already succeeded. A read failure cannot make a retry safe.
      throw new CodexError(
        failure.code,
        forkedId
          ? `已创建分支会话 ${forkedId}，但无法加载历史；请从会话列表重新打开，不要重复 fork。${failure.message}`
          : `Codex fork 已返回结果，但无法确认新会话；请检查会话列表，不要重复 fork。${failure.message}`,
        true,
        failure.rpcCode,
      );
    }
  }
  async startTurn(
    id: string,
    cwd: string,
    text: string,
    settings?: Settings,
    images?: string[],
  ): Promise<TurnView> {
    this.validateSettings(settings);
    const turn = mapTurn(
      id,
      (
        await this.call('turn/start', {
          threadId: id,
          cwd,
          input: taskInput(text, images),
          ...turnSettings(cwd, settings),
        })
      ).turn,
    );
    return turn;
  }
  steerTurn(
    id: string,
    turnId: string,
    text: string,
    images?: string[],
  ): Promise<TurnSteerResponse> {
    return this.call('turn/steer', {
      threadId: id,
      expectedTurnId: turnId,
      input: taskInput(text, images),
    });
  }
  async interruptTurn(id: string, turnId: string): Promise<void> {
    await this.call('turn/interrupt', { threadId: id, turnId });
  }

  private notification(message: RpcNotification): void {
    if (this.titles?.notification(message)) return;
    const event = message as ServerNotification;
    const p = event.params;
    switch (event.method) {
      case 'thread/settings/updated':
        this.emit({
          type: 'threadSettings',
          threadId: event.params.threadId,
          settings: {
            model: event.params.threadSettings.model ?? null,
            reasoningEffort: event.params.threadSettings.effort ?? null,
            ...permissionSettings(
              event.params.threadSettings.sandboxPolicy,
              event.params.threadSettings.approvalPolicy,
              event.params.threadSettings.approvalsReviewer,
            ),
          },
        });
        break;
      case 'item/autoApprovalReview/started':
      case 'item/autoApprovalReview/completed':
        this.emit({
          type: 'autoReview',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          review: mapAutoReview(event.params),
        });
        break;
      case 'thread/started':
        this.emit({ type: 'thread', thread: mapThread(event.params.thread) });
        break;
      case 'thread/name/updated':
        this.emit({
          type: 'threadName',
          threadId: event.params.threadId,
          name: event.params.threadName,
        });
        break;
      case 'thread/status/changed':
        this.emit({
          type: 'threadStatus',
          threadId: event.params.threadId,
          status: threadStatus(event.params.status),
        });
        break;
      case 'turn/started':
      case 'turn/completed':
        this.emit({
          type: 'turn',
          threadId: event.params.threadId,
          turn: mapTurn(event.params.threadId, event.params.turn),
        });
        if (event.method === 'turn/completed')
          this.expireActions(event.params.threadId, event.params.turn.id);
        break;
      case 'item/started':
      case 'item/completed':
        this.emit({
          type: 'item',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          item: mapItem(event.params.item),
        });
        break;
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        this.emit({
          type: 'delta',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          itemId: event.params.itemId,
          field: event.method.includes('outputDelta') ? 'output' : 'text',
          delta: event.params.delta,
          itemType: event.method.split('/')[1]!,
        });
        break;
      case 'turn/diff/updated':
        this.emit({
          type: 'diff',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          diff: event.params.diff,
        });
        break;
      case 'item/fileChange/patchUpdated':
        this.emit({
          type: 'item',
          threadId: event.params.threadId,
          turnId: event.params.turnId,
          item: mapItem({
            type: 'fileChange',
            id: event.params.itemId,
            changes: event.params.changes,
            status: 'inProgress',
          }),
        });
        break;
      case 'serverRequest/resolved': {
        const actionId = this.actionIds.get(event.params.requestId);
        if (actionId) {
          this.emit({ type: 'actionResolved', actionId });
          this.actions.delete(actionId);
          this.actionIds.delete(event.params.requestId);
        }
        break;
      }
      case 'error':
        if (!event.params.willRetry) {
          this.state.error = event.params.error.message;
          this.publishRuntime();
        }
        break;
      default: // Unknown noninteractive notifications cannot authorize any action.
        if (!isRecord(p)) break;
    }
  }
  private async serverRequest(message: RpcServerRequest): Promise<void> {
    if (isRecord(message.params) && this.titles?.isInternal(message.params.threadId)) {
      await this.rpc?.reject(
        message.id,
        -32601,
        'Interactive tools are disabled for title generation',
      );
      return;
    }
    const request = message as ServerRequest;
    const params: Record<string, unknown> = isRecord(message.params) ? message.params : {};
    const action: PendingAction = {
      actionId: randomUUID(),
      codexEpoch: this.epoch,
      rpcId: message.id,
      kind: 'unsupported',
      status: 'pending',
      title: '不支持的 Codex 交互请求',
      options: [],
      ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
    };
    const decisions = new Map<string, CommandExecutionApprovalDecision>();
    if (
      request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval'
    ) {
      for (const [id, label] of [
        ['accept', '允许本次'],
        ['acceptForSession', '本会话允许'],
        ['decline', '拒绝'],
        ['cancel', '取消当前任务'],
      ] as const) {
        action.options.push({ id, label });
        decisions.set(id, id);
      }
      action.reason = request.params.reason ?? undefined;
      if (request.method === 'item/commandExecution/requestApproval') {
        const p = request.params;
        action.kind = p.networkApprovalContext ? 'network' : 'command';
        action.title = p.networkApprovalContext
          ? `网络权限：${p.networkApprovalContext.protocol}://${p.networkApprovalContext.host}`
          : '命令审批';
        action.command = p.command ?? undefined;
        action.cwd = p.cwd ?? undefined;
        action.details = {
          kind: p.kind,
          network: p.networkApprovalContext,
          commandActions: p.commandActions,
        };
        if (p.proposedExecpolicyAmendment) {
          action.options.push({
            id: 'acceptWithRule',
            label: `允许并记住命令规则：${p.proposedExecpolicyAmendment.join(' ')}`,
          });
          decisions.set('acceptWithRule', {
            acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment },
          });
        }
        p.proposedNetworkPolicyAmendments?.forEach((amendment, index) => {
          const id = `networkRule:${index}`;
          action.options.push({ id, label: `应用网络规则：${JSON.stringify(amendment)}` });
          decisions.set(id, {
            applyNetworkPolicyAmendment: { network_policy_amendment: amendment },
          });
        });
      } else {
        action.kind = 'file';
        action.title = '文件变更审批';
        action.details = { itemId: request.params.itemId, grantRoot: request.params.grantRoot };
      }
    } else if (request.method === 'item/permissions/requestApproval') {
      const p = request.params;
      action.kind = 'permissions';
      action.title = '额外权限审批';
      action.reason = p.reason ?? undefined;
      action.cwd = p.cwd;
      action.options = [
        { id: 'accept', label: '当前任务允许' },
        { id: 'acceptForSession', label: '本会话允许' },
        { id: 'decline', label: '拒绝' },
      ];
      action.permissionRequest = {
        ...(p.permissions.network === null ? {} : { network: p.permissions.network.enabled }),
        ...(p.permissions.fileSystem === null
          ? {}
          : {
              fileSystem: {
                read: p.permissions.fileSystem.read ?? [],
                write: p.permissions.fileSystem.write ?? [],
                entries: (p.permissions.fileSystem.entries ?? []).map((entry) => ({
                  path: permissionPathLabel(entry.path),
                  access: entry.access,
                })),
                ...(p.permissions.fileSystem.globScanMaxDepth === undefined
                  ? {}
                  : {
                      globScanMaxDepth: p.permissions.fileSystem.globScanMaxDepth,
                    }),
              },
            }),
      };
      action.details = {
        itemId: p.itemId,
        environmentId: p.environmentId,
        permissions: p.permissions,
      };
    } else if (request.method === 'mcpServer/elicitation/request') {
      action.kind = 'elicitation';
      action.title = `MCP 交互：${request.params.serverName}`;
      action.reason = request.params.message;
      action.elicitation = normalizeElicitationRequest(params);
      action.options = [
        { id: 'accept', label: action.elicitation.mode === 'url' ? '已完成，继续' : '提交' },
        { id: 'decline', label: '拒绝' },
        { id: 'cancel', label: '取消' },
      ];
      // Keep an unsupported schema reviewable while allowing an explicit decline/cancel.
      if (action.elicitation.schemaError)
        action.details = { requestedSchema: params.requestedSchema, mode: params.mode };
    } else if (request.method === 'item/tool/requestUserInput') {
      action.kind = 'questions';
      action.title = '需要你的回答';
      action.blocking = request.params.isBlocking;
      action.questions = request.params.questions.map((question) => ({
        ...question,
        options: question.options ?? [],
      }));
    } else {
      action.status = 'expired';
      action.reason = `当前 Web UI 尚未实现 ${message.method}`;
      this.emit({ type: 'action', action });
      this.state.error = action.reason;
      this.publishRuntime();
      await this.rpc!.reject(
        message.id,
        -32601,
        `Unsupported interactive request: ${message.method}`,
      );
      return;
    }
    this.actions.set(action.actionId, { action, request, decisions, responding: false });
    this.actionIds.set(message.id, action.actionId);
    this.emit({ type: 'action', action: structuredClone(action) });
  }
  async respond(actionId: string, resolution: ActionResolution): Promise<void> {
    const context = this.actions.get(actionId);
    if (!context || context.action.codexEpoch !== this.epoch || !this.ready)
      throw new AppError('ACTION_EXPIRED', '此人工请求已失效', 409);
    if (context.responding) throw new AppError('ACTION_CONFLICT', '此人工请求已提交回答', 409);
    let response:
      | ToolRequestUserInputResponse
      | CommandExecutionRequestApprovalResponse
      | FileChangeRequestApprovalResponse
      | PermissionsRequestApprovalResponse
      | McpServerElicitationRequestResponse;
    if (context.request.method === 'item/permissions/requestApproval') {
      const decision = validatePermissionResolution(resolution);
      const requested = context.request.params.permissions;
      response = {
        permissions:
          decision === 'decline'
            ? {}
            : structuredClone({
                ...(requested.network === null ? {} : { network: requested.network }),
                ...(requested.fileSystem === null ? {} : { fileSystem: requested.fileSystem }),
              }),
        scope: decision === 'acceptForSession' ? 'session' : 'turn',
      };
    } else if (context.request.method === 'mcpServer/elicitation/request') {
      const content = validateElicitationResolution(
        normalizeElicitationRequest({ ...context.request.params }),
        resolution,
      );
      response = {
        action: (resolution as { decision: 'accept' | 'decline' | 'cancel' }).decision,
        content,
        _meta: null,
      };
    } else if (context.request.method === 'item/tool/requestUserInput') {
      if (!('answers' in resolution))
        throw new AppError('VALIDATION_ERROR', '此请求需要结构化回答');
      const questions = context.request.params.questions;
      const ids = new Set(questions.map((question) => question.id));
      if (Object.keys(resolution.answers).some((id) => !ids.has(id)))
        throw new AppError('VALIDATION_ERROR', '回答包含未知题目');
      const answers: ToolRequestUserInputResponse['answers'] = {};
      for (const question of questions) {
        const values = resolution.answers[question.id];
        if (
          !Array.isArray(values) ||
          !values.length ||
          values.some((value) => typeof value !== 'string' || !value.trim())
        )
          throw new AppError('VALIDATION_ERROR', `请回答 ${question.header}`);
        if (
          question.options?.length &&
          !question.isOther &&
          values.some((value) => !question.options!.some((option) => option.label === value))
        )
          throw new AppError('VALIDATION_ERROR', `题目 ${question.header} 只接受所列选项`);
        answers[question.id] = { answers: values };
      }
      response = { answers };
    } else {
      if (
        !('decision' in resolution) ||
        'content' in resolution ||
        !context.decisions.has(resolution.decision)
      )
        throw new AppError('VALIDATION_ERROR', '此请求不支持所提交的决定');
      response = { decision: context.decisions.get(resolution.decision)! };
    }
    context.responding = true;
    try {
      await this.rpc!.respond(context.action.rpcId, response);
    } catch (error) {
      if (error instanceof CodexError && !error.uncertain) context.responding = false;
      throw error;
    }
  }
  private expireActions(threadId?: string, turnId?: string): void {
    for (const [id, context] of this.actions) {
      if (threadId && context.action.threadId !== threadId) continue;
      if (turnId && context.action.turnId !== turnId) continue;
      this.emit({ type: 'action', action: { ...context.action, status: 'expired' } });
      this.actions.delete(id);
      this.actionIds.delete(context.action.rpcId);
    }
  }
}
