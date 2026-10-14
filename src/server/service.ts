import type { CodexClient, CodexDiagnostics, CodexEvent } from '../codex/types.js';
import { AppError } from '../shared/errors.js';
import {
  validateElicitationResolution,
  validatePermissionResolution,
} from '../shared/elicitation.js';
import { toThreadSummary } from '../shared/thread-summary.js';
import type {
  ConfirmCompatibilityInput,
  CreateThreadInput,
  Cursor,
  ForkThreadInput,
  InterruptInput,
  Operation,
  PendingAction,
  ReconcileInput,
  ResolveActionInput,
  ResumeThreadInput,
  ServerMessage,
  StartTurnInput,
  SteerInput,
  SystemInfo,
  ThreadPage,
  ThreadSummaryPage,
  ThreadView,
} from '../shared/types.js';
import {
  OperationStore,
  StoreConflict,
  type ExecutionMarker,
  type OperationRow,
} from './db/operations.js';
import { EventHub } from './events.js';
import { Projection, isActive, isTerminal } from './projection.js';
import { ProjectRegistry } from './projects.js';

export interface GatewayOptions {
  store: OperationStore;
  projects: ProjectRegistry;
  codex: CodexClient;
  limits?: { eventBytes: number; itemBytes: number; wsBytes?: number };
  authMode?: SystemInfo['authMode'];
  demo?: boolean;
}

/** Coordinates durable intent, upstream effects, and the recoverable browser projection. */
export class GatewayService {
  readonly events: EventHub;
  readonly projection: Projection;
  private readonly store: OperationStore;
  private readonly projects: ProjectRegistry;
  private readonly codex: CodexClient;
  private readonly removeListener: () => void;
  private accepting = true;
  private currentEpoch: string;
  private confirmedCompatibility: string | undefined;
  private readonly reads = new Map<string, Promise<ThreadView>>();
  private readonly executionReads = new Map<string, Promise<void>>();
  private readonly summaries = new Map<string, string>();

  constructor(private readonly options: GatewayOptions) {
    this.store = options.store;
    this.projects = options.projects;
    this.codex = options.codex;
    this.events = new EventHub(options.limits?.eventBytes);
    this.projection = new Projection(options.limits?.itemBytes);
    this.currentEpoch = this.codex.epoch;
    this.store.recover();
    this.removeListener = this.codex.onEvent((event) => this.consume(event));
  }

  listProjects() {
    return this.projects.list();
  }
  getSystem(): SystemInfo {
    const diagnostics = this.codex.diagnostics();
    return {
      ...diagnostics,
      compatibilityConfirmation: this.compatibilityConfirmation(diagnostics),
      authMode: this.options.authMode ?? 'local',
      demo: this.options.demo ?? false,
    };
  }
  subscribeRuntime(listener: (message: ServerMessage) => void): () => void {
    return this.events.subscribeRuntime(listener);
  }
  subscribeOverview(listener: (message: ServerMessage) => void): () => void {
    return this.events.subscribeOverview(listener);
  }

  async confirmCompatibility(input: ConfirmCompatibilityInput): Promise<Operation> {
    return this.perform('system.compatibility.confirm', 'system', input, async () => {
      const diagnostics = this.codex.diagnostics();
      this.ensureCompatibilityAvailable(diagnostics);
      if (
        input.confirm !== true ||
        input.codexEpoch !== diagnostics.codexEpoch ||
        input.codexVersion !== diagnostics.codexVersion ||
        input.verifiedVersion !== diagnostics.verifiedVersion
      )
        throw new AppError(
          'COMPATIBILITY_CHANGED',
          'Codex 运行版本或验证基线已变化，请刷新后重新确认',
          409,
        );
      this.store.dispatch(input.clientOperationId);
      const fingerprint = this.compatibilityFingerprint(diagnostics);
      return {
        result: {
          codexEpoch: diagnostics.codexEpoch,
          codexVersion: diagnostics.codexVersion,
          verifiedVersion: diagnostics.verifiedVersion,
          compatibilityConfirmation:
            diagnostics.compatibility === 'unverified' ? 'confirmed' : 'not-required',
        },
        onAcknowledged: () => {
          const current = this.codex.diagnostics();
          if (
            this.codex.ready &&
            current.ready &&
            current.compatibility === 'unverified' &&
            this.compatibilityFingerprint(current) === fingerprint
          )
            this.confirmedCompatibility = fingerprint;
          this.events.publish('runtime', this.getSystem());
        },
      };
    });
  }

  async listThreads(projectId: string, cursor?: string): Promise<ThreadPage> {
    const project = this.projects.get(projectId);
    const page = await this.codex.listThreads(project.canonicalRoot, cursor);
    const data: ThreadView[] = [];
    for (const thread of page.data) {
      try {
        const normalized = this.normalize(thread, projectId);
        const cached = this.projection.get(thread.id);
        data.push(this.threadView(cached ?? normalized));
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !['PROJECT_OWNERSHIP', 'PROJECT_UNAVAILABLE'].includes(error.code)
        )
          throw error;
      }
    }
    if (cursor === undefined) {
      // A new/active managed thread may not be indexed in upstream history yet.
      // Always make recent owned sessions discoverable after reopening a browser.
      const managed = this.projection
        .values()
        .filter((thread) => thread.managed && thread.projectId === projectId)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 30);
      for (const thread of managed) {
        this.projects.assertOwnership(projectId, thread.cwd);
        if (!data.some((entry) => entry.id === thread.id)) data.unshift(this.threadView(thread));
      }
    }
    return { data, nextCursor: page.nextCursor };
  }

  async listThreadSummaries(projectId: string, cursor?: string): Promise<ThreadSummaryPage> {
    // The list can race with live updates. Browsers retain updates newer than this boundary.
    const boundary = this.events.cursor();
    const page = await this.listThreads(projectId, cursor);
    return { data: page.data.map(toThreadSummary), nextCursor: page.nextCursor, cursor: boundary };
  }

  async getThread(threadId: string): Promise<ThreadView> {
    const cached = this.projection.get(threadId);
    if (cached) {
      this.projects.assertOwnership(cached.projectId, cached.cwd);
      const marker = this.store.activeForThread(threadId);
      if (marker?.turnId && this.codex.ready) {
        await this.refreshExecution(marker);
        return this.threadView(cached);
      }
      // Managed ownership does not make an unknown projection authoritative.
      if (cached.status !== 'unknown' || !this.codex.ready) return this.threadView(cached);
    }
    const existing = this.reads.get(threadId);
    if (existing) return this.threadView(await existing);
    const revision = this.projection.revision(threadId);
    const loading = (async () => {
      const thread = this.normalize(await this.codex.readThread(threadId));
      // Managed live projections are never replaced by a history read finishing later.
      const current = this.projection.get(threadId);
      const preserveCurrent =
        current && (cached === undefined || this.projection.revision(threadId) !== revision);
      const result = preserveCurrent ? current : this.projection.thread(thread);
      this.applyRecoveredMarker(result);
      if (!preserveCurrent)
        for (const turn of result.turns)
          if (isTerminal(turn.status)) this.projection.expireTurn(threadId, turn.id);
      if (cached !== undefined && !preserveCurrent) this.publishThread(threadId);
      return result;
    })();
    this.reads.set(threadId, loading);
    try {
      return this.threadView(await loading);
    } finally {
      this.reads.delete(threadId);
    }
  }

  async createThread(projectId: string, input: CreateThreadInput): Promise<Operation> {
    return this.perform('thread.create', projectId, input, async () => {
      const project = this.projects.get(projectId);
      this.ensureReady();
      this.ensureCompatibilityConfirmed();
      this.store.dispatch(input.clientOperationId);
      const thread = await this.codex.createThread(project.canonicalRoot, input.settings);
      const normalized = this.normalize(thread, projectId, true);
      this.projection.thread(normalized, this.projection.get(thread.id) !== undefined);
      this.publishThread(thread.id);
      return { result: { threadId: thread.id } };
    });
  }

  async resumeThread(threadId: string, input: ResumeThreadInput): Promise<Operation> {
    return this.perform('thread.resume', threadId, input, async () => {
      const thread = await this.getThread(threadId);
      this.ensureReady();
      const link = this.store.getThreadLink(threadId);
      if (link?.managedEpoch === this.codex.epoch) {
        this.ensureCompatibilityConfirmed();
        this.store.dispatch(input.clientOperationId);
        return { result: { threadId } };
      }
      if (!input.confirmExternalStopped)
        throw new AppError('EXTERNAL_HANDOFF_REQUIRED', '请先确认原 CLI 已停止使用此会话', 409);
      const marker = this.store.activeForThread(threadId);
      if (marker)
        throw new AppError('RESULT_UNKNOWN', '旧执行仍待核对，请先检查历史并核对旧操作', 409, {
          operationId: marker.operationId,
          threadId,
        });
      const ownership = this.projects.assertOwnership(thread.projectId, thread.cwd);
      const revision = this.projection.revision(threadId);
      this.ensureCompatibilityConfirmed();
      this.store.dispatch(input.clientOperationId);
      const resumed = this.normalize(
        await this.codex.resumeThread(threadId, ownership.cwd, input.settings),
        thread.projectId,
        true,
      );
      this.projection.thread(resumed, this.projection.revision(threadId) !== revision);
      this.publishThread(threadId);
      return { result: { threadId } };
    });
  }

  async forkThread(threadId: string, input: ForkThreadInput): Promise<Operation> {
    return this.perform('thread.fork', threadId, input, async () => {
      this.ensureReady();
      // Reading through getThread can reconcile recovered execution markers. Forking only
      // reads the source: its ownership, projection and execution remain untouched.
      const source = this.projection.get(threadId) ?? (await this.codex.readThread(threadId));
      const link = this.store.getThreadLink(threadId);
      const ownership = link
        ? this.projects.assertOwnership(link.projectId, source.cwd)
        : this.projects.findOwner(source.cwd);
      this.ensureCompatibilityConfirmed();
      const epoch = this.codex.epoch;
      this.store.dispatch(input.clientOperationId);
      const forked = await this.codex.forkThread(threadId, ownership.cwd, input.settings);
      if (forked.id === threadId || this.codex.epoch !== epoch || !this.codex.ready)
        throw new Error('分叉请求已发送，但返回的新会话无法确认，请核对历史');
      let normalized: ThreadView;
      try {
        normalized = this.normalize(
          { ...forked, forkedFromId: threadId },
          ownership.project.id,
          true,
        );
      } catch (error) {
        // A malformed result does not prove that upstream failed to create the fork.
        throw new Error('分叉请求已发送，但返回的会话目录无法确认，请核对历史', { cause: error });
      }
      this.projection.thread(normalized, this.projection.get(forked.id) !== undefined);
      this.publishThread(forked.id);
      return { result: { threadId: forked.id, forkedFromId: threadId } };
    });
  }

  async startTurn(threadId: string, input: StartTurnInput): Promise<Operation> {
    return this.perform('turn.start', threadId, input, async () => {
      const thread = await this.getThread(threadId);
      this.ensureManaged(thread);
      const ownership = this.projects.assertOwnership(thread.projectId, thread.cwd);
      if (isActive(thread.status))
        throw new AppError('THREAD_BUSY', '会话已有活动任务，请追加要求或中断', 409, { threadId });
      this.ensureCompatibilityConfirmed();
      this.store.dispatch(input.clientOperationId, {
        threadId,
        workspaceKey: ownership.workspaceKey,
        codexEpoch: this.codex.epoch,
      });
      const revision = this.projection.revision(threadId);
      const turn = await this.codex.startTurn(threadId, ownership.cwd, input.text, input.settings);
      this.store.attachTurn(input.clientOperationId, turn.id);
      this.projection.turn(threadId, turn, this.projection.revision(threadId) !== revision);
      const projectedTurn = this.projection
        .get(threadId)
        ?.turns.find((entry) => entry.id === turn.id);
      if (projectedTurn && isTerminal(projectedTurn.status))
        this.store.finishTurn(threadId, turn.id, this.codex.epoch);
      this.publishThread(threadId);
      return { result: { threadId, turnId: turn.id }, turnId: turn.id };
    });
  }

  async steer(threadId: string, input: SteerInput): Promise<Operation> {
    return this.perform('turn.steer', threadId, input, async () => {
      await this.requireActiveTurn(threadId, input.expectedTurnId);
      this.ensureCompatibilityConfirmed();
      this.store.dispatch(input.clientOperationId);
      const result = await this.codex.steerTurn(threadId, input.expectedTurnId, input.text);
      return { result: { threadId, turnId: result.turnId } };
    });
  }

  async interrupt(threadId: string, input: InterruptInput): Promise<Operation> {
    return this.perform('turn.interrupt', threadId, input, async () => {
      await this.requireActiveTurn(threadId, input.expectedTurnId);
      this.store.dispatch(input.clientOperationId);
      await this.codex.interruptTurn(threadId, input.expectedTurnId);
      // Upstream turn/completed is the only normal release; an interrupt receipt is not one.
      return { result: { threadId, turnId: input.expectedTurnId } };
    });
  }

  async resolveAction(actionId: string, input: ResolveActionInput): Promise<Operation> {
    return this.perform('action.resolve', actionId, input, async () => {
      this.ensureReady();
      let action = this.projection.actions.get(actionId);
      if (!action || action.codexEpoch !== this.codex.epoch || action.status === 'expired')
        throw new AppError('ACTION_EXPIRED', '该人工请求已失效', 409);
      if (action.status !== 'pending')
        throw new AppError('ACTION_CONFLICT', '该人工请求已由另一次提交处理', 409);
      if (action.threadId) await this.getThread(action.threadId);
      // Recheck after the only async validation before the atomic in-memory claim.
      action = this.projection.actions.get(actionId);
      if (!action || action.status === 'expired' || action.codexEpoch !== this.codex.epoch)
        throw new AppError('ACTION_EXPIRED', '该人工请求已失效', 409);
      if (action.status !== 'pending')
        throw new AppError('ACTION_CONFLICT', '该人工请求已被处理', 409);
      this.validateResolution(action, input);
      this.ensureCompatibilityConfirmed();
      this.store.dispatch(input.clientOperationId);
      this.projection.resolveAction(actionId, 'responding');
      if (action.threadId) this.publishThread(action.threadId);
      await this.codex.respond(actionId, input.resolution);
      return { result: { actionId } };
    });
  }

  getOperation(id: string): Operation {
    const row = this.store.get(id);
    if (!row) throw new AppError('OPERATION_NOT_FOUND', '未找到该操作', 404);
    return this.operation(row);
  }

  async reconcileOperation(targetOperationId: string, input: ReconcileInput): Promise<Operation> {
    return this.perform('operation.reconcile', targetOperationId, input, async () => {
      if (!input.confirmEnded)
        throw new AppError('CONFIRMATION_REQUIRED', '必须确认对应旧运行已经结束', 400);
      const target = this.store.get(targetOperationId);
      if (!target) throw new AppError('OPERATION_NOT_FOUND', '待核对操作不存在', 404);
      const marker = this.store.marker(targetOperationId);
      if (!marker || marker.endedAt !== null) {
        // Repeating a decision for an already released execution cannot touch a newer lock.
        this.store.dispatch(input.clientOperationId);
        this.store.reconcile(targetOperationId, input.clientOperationId);
        return { result: this.store.get(input.clientOperationId)?.result };
      }
      const cached = this.projection.get(marker.threadId);
      if (
        marker.codexEpoch === this.codex.epoch &&
        cached &&
        this.markerIsActive(cached, marker.turnId)
      )
        throw new AppError('THREAD_BUSY', '受管任务仍在执行，请先正常中断', 409, {
          threadId: marker.threadId,
        });
      if (this.codex.ready) {
        try {
          const actual = await this.codex.readThread(marker.threadId);
          const link = this.store.getThreadLink(marker.threadId);
          if (link) this.projects.assertOwnership(link.projectId, actual.cwd);
          else this.projects.findOwner(actual.cwd);
          if (this.markerIsActive(actual, marker.turnId))
            throw new AppError('THREAD_BUSY', '上游仍报告该任务活动，不能解除占用', 409, {
              threadId: marker.threadId,
            });
        } catch (error) {
          if (
            error instanceof AppError &&
            ['THREAD_BUSY', 'PROJECT_OWNERSHIP'].includes(error.code)
          )
            throw error;
          // Unavailable historical state still requires the explicit human confirmation above.
        }
      }
      const latest = this.projection.get(marker.threadId);
      if (
        marker.codexEpoch === this.codex.epoch &&
        latest &&
        this.markerIsActive(latest, marker.turnId)
      )
        throw new AppError('THREAD_BUSY', '受管任务仍在执行，请先正常中断', 409);
      this.store.dispatch(input.clientOperationId);
      this.store.reconcile(targetOperationId, input.clientOperationId);
      const thread = this.projection.get(marker.threadId);
      if (thread?.status === 'unknown') {
        thread.status = 'idle';
        this.publishThread(thread.id);
      }
      this.events.publish('operation', this.getOperation(targetOperationId), marker.threadId);
      return { result: this.store.get(input.clientOperationId)?.result };
    });
  }

  async subscribe(
    threadId: string,
    after: Cursor | undefined,
    listener: (message: ServerMessage) => void,
  ): Promise<() => void> {
    await this.getThread(threadId);
    return this.events.subscribe(
      threadId,
      () => this.threadView(this.projection.get(threadId)!),
      after,
      listener,
    );
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    this.store.recover();
    this.projection.runtimeReset();
    this.removeListener();
    await this.codex.stop();
  }

  private async perform<T extends { clientOperationId: string }>(
    kind: string,
    target: string,
    input: T,
    work: () => Promise<{ result: unknown; turnId?: string; onAcknowledged?: () => void }>,
  ): Promise<Operation> {
    if (!this.accepting) throw new AppError('CODEX_UNAVAILABLE', '服务正在关闭', 503);
    let accepted;
    try {
      accepted = this.store.accept(input.clientOperationId, kind, target, input);
    } catch (error) {
      throw this.asAppError(error);
    }
    if (!accepted.inserted) return this.operation(accepted.operation);
    try {
      const { result, turnId, onAcknowledged } = await work();
      const operation = this.operation(
        this.store.acknowledge(input.clientOperationId, result, turnId),
      );
      if (operation.status === 'acknowledged') onAcknowledged?.();
      this.events.publish('operation', operation);
      return operation;
    } catch (error) {
      const appError = this.asAppError(error);
      const state = this.store.get(input.clientOperationId)?.state;
      const dispatched = state === 'dispatching';
      const uncertain =
        state === 'unknown' ||
        (dispatched &&
          (typeof error === 'object' && error !== null && 'uncertain' in error
            ? Boolean(error.uncertain)
            : !(error instanceof AppError)));
      const operation = this.operation(
        this.store.fail(
          input.clientOperationId,
          { ...appError.toJSON(), code: uncertain ? 'RESULT_UNKNOWN' : appError.code },
          uncertain,
        ),
      );
      if (
        dispatched &&
        !uncertain &&
        kind === 'action.resolve' &&
        this.projection.actions.get(target)?.status === 'responding'
      ) {
        const action = this.projection.resolveAction(target, 'pending');
        if (action?.threadId) this.publishThread(action.threadId);
      }
      this.events.publish('operation', operation);
      if (uncertain)
        throw new AppError(
          'RESULT_UNKNOWN',
          '请求可能已经执行，结果待核对；请勿自动重新提交',
          409,
          { clientOperationId: input.clientOperationId },
        );
      throw appError;
    }
  }

  private normalize(thread: ThreadView, projectId?: string, managed = false): ThreadView {
    const link = this.store.getThreadLink(thread.id);
    const ownership = projectId
      ? this.projects.assertOwnership(projectId, thread.cwd)
      : link
        ? this.projects.assertOwnership(link.projectId, thread.cwd)
        : this.projects.findOwner(thread.cwd);
    const managedEpoch = managed ? this.codex.epoch : (link?.managedEpoch ?? null);
    const result: ThreadView = {
      ...thread,
      projectId: ownership.project.id,
      cwd: ownership.cwd,
      managed: managedEpoch === this.codex.epoch,
      actions: [...this.projection.actions.values()].filter(
        (action) => action.threadId === thread.id,
      ),
    };
    this.store.linkThread({
      threadId: thread.id,
      projectId: ownership.project.id,
      cwd: ownership.cwd,
      source: thread.source,
      managedEpoch,
    });
    this.applyRecoveredMarker(result);
    return result;
  }

  private applyRecoveredMarker(thread: ThreadView): void {
    const marker = this.store.activeForThread(thread.id);
    if (marker?.state === 'unknown') {
      const confirmed = thread.turns.find((entry) => entry.id === marker.turnId);
      if (
        confirmed &&
        isTerminal(confirmed.status) &&
        !isActive(thread.status) &&
        !thread.turns.some((entry) => isActive(entry.status))
      ) {
        this.store.finishTurn(thread.id, confirmed.id, marker.codexEpoch);
        return;
      }
      thread.status = 'unknown';
      const turn = thread.turns.find((entry) => entry.id === marker.turnId);
      if (turn && !isTerminal(turn.status)) turn.status = 'unknown';
    }
  }

  /** Refresh only this thread; missing completion events must not block its next turn. */
  private async refreshExecution(marker: ExecutionMarker): Promise<void> {
    if (!marker.turnId || !this.codex.ready) return;
    const existing = this.executionReads.get(marker.operationId);
    if (existing) return existing;
    const epoch = this.codex.epoch;
    const revision = this.projection.revision(marker.threadId);
    const reading = (async () => {
      try {
        const actual = await this.codex.readThread(marker.threadId);
        const latest = this.store.activeForThread(marker.threadId);
        // A delayed read cannot release a replacement execution or overwrite newer live events.
        if (
          !this.codex.ready ||
          this.codex.epoch !== epoch ||
          actual.id !== marker.threadId ||
          latest?.operationId !== marker.operationId ||
          latest.turnId !== marker.turnId ||
          latest.codexEpoch !== marker.codexEpoch ||
          this.projection.revision(marker.threadId) !== revision
        )
          return;
        const link = this.store.getThreadLink(marker.threadId);
        const ownership = link
          ? this.projects.assertOwnership(link.projectId, actual.cwd)
          : this.projects.findOwner(actual.cwd);
        if (ownership.workspaceKey !== marker.workspaceKey) return;
        const turn = actual.turns.find((entry) => entry.id === marker.turnId);
        if (
          turn &&
          isActive(turn.status) &&
          latest.state === 'active' &&
          this.projection.get(marker.threadId)?.status === 'unknown'
        ) {
          // A notLoaded status can hide an active managed turn. Restore its live controls
          // only after the same identity, runtime and revision checks used for completion.
          this.projection.thread(this.normalize(actual));
          this.publishThread(marker.threadId);
          return;
        }
        if (
          !turn ||
          !isTerminal(turn.status) ||
          isActive(actual.status) ||
          actual.turns.some((entry) => isActive(entry.status))
        )
          return;
        this.store.finishTurn(marker.threadId, turn.id, marker.codexEpoch);
        this.projection.thread(this.normalize(actual));
        this.projection.expireTurn(marker.threadId, turn.id);
        this.publishThread(marker.threadId);
        this.events.publish('operation', this.getOperation(marker.operationId), marker.threadId);
      } catch {
        // Missing/unavailable history is not terminal evidence. Keep the durable reservation.
      }
    })();
    this.executionReads.set(marker.operationId, reading);
    try {
      return await reading;
    } finally {
      this.executionReads.delete(marker.operationId);
    }
  }

  private ensureReady(): void {
    if (!this.codex.ready)
      throw new AppError('CODEX_UNAVAILABLE', 'Codex 尚未就绪，请查看运行状态', 503);
  }

  private compatibilityFingerprint(diagnostics: CodexDiagnostics): string {
    return JSON.stringify([
      diagnostics.codexEpoch,
      diagnostics.codexVersion,
      diagnostics.verifiedVersion,
    ]);
  }

  private compatibilityConfirmation(
    diagnostics: CodexDiagnostics,
  ): SystemInfo['compatibilityConfirmation'] {
    const fingerprint = this.compatibilityFingerprint(diagnostics);
    if (
      !this.codex.ready ||
      !diagnostics.ready ||
      diagnostics.compatibility !== 'unverified' ||
      !diagnostics.codexVersion ||
      this.confirmedCompatibility !== fingerprint
    )
      this.confirmedCompatibility = undefined;
    if (diagnostics.compatibility !== 'unverified') return 'not-required';
    return this.confirmedCompatibility === fingerprint ? 'confirmed' : 'required';
  }

  private ensureCompatibilityAvailable(diagnostics: CodexDiagnostics): void {
    this.compatibilityConfirmation(diagnostics);
    this.ensureReady();
    if (
      !diagnostics.ready ||
      diagnostics.compatibility === 'unavailable' ||
      !diagnostics.codexVersion
    )
      throw new AppError('CODEX_UNAVAILABLE', 'Codex 不可用或无法识别运行版本，请先检查诊断', 503);
  }

  private ensureCompatibilityConfirmed(): void {
    const diagnostics = this.codex.diagnostics();
    this.ensureCompatibilityAvailable(diagnostics);
    if (this.compatibilityConfirmation(diagnostics) === 'required')
      throw new AppError(
        'COMPATIBILITY_CONFIRMATION_REQUIRED',
        '当前 Codex 版本尚未验证，请先确认继续使用此版本',
        409,
      );
  }

  private ensureManaged(thread: ThreadView): void {
    this.ensureReady();
    if (!thread.managed || this.store.getThreadLink(thread.id)?.managedEpoch !== this.codex.epoch)
      throw new AppError('THREAD_NOT_RESUMED', '请先完成会话交接并恢复此会话', 409);
  }

  private async requireActiveTurn(threadId: string, expectedTurnId: string): Promise<void> {
    const thread = await this.getThread(threadId);
    this.ensureManaged(thread);
    const turn = thread.turns.find((entry) => entry.id === expectedTurnId);
    const marker = this.store.activeForThread(threadId);
    if (
      !turn ||
      !isActive(turn.status) ||
      !marker ||
      marker.turnId !== expectedTurnId ||
      marker.codexEpoch !== this.codex.epoch
    )
      throw new AppError('TURN_CONFLICT', '目标任务已改变或不再活动，请刷新状态', 409);
  }

  private markerIsActive(thread: ThreadView, turnId: string | null): boolean {
    if (turnId) return thread.turns.some((turn) => turn.id === turnId && isActive(turn.status));
    return isActive(thread.status) || thread.turns.some((turn) => isActive(turn.status));
  }

  private validateResolution(action: PendingAction, input: ResolveActionInput): void {
    const resolution = input.resolution;
    if (action.kind === 'permissions') {
      validatePermissionResolution(resolution);
    } else if (action.kind === 'elicitation') {
      validateElicitationResolution(action.elicitation, resolution);
    } else if (action.kind === 'questions') {
      if (!('answers' in resolution)) throw new AppError('VALIDATION_ERROR', '请按问题提交答案');
      const questions = action.questions ?? [];
      if (
        Object.keys(resolution.answers).some(
          (id) => !questions.some((question) => question.id === id),
        )
      )
        throw new AppError('VALIDATION_ERROR', '回答包含未知问题');
      for (const question of questions) {
        const answers = resolution.answers[question.id];
        if (
          !answers?.length ||
          answers.some(
            (answer) =>
              !answer.trim() ||
              (!question.isOther &&
                question.options.length > 0 &&
                !question.options.some((option) => option.label === answer)),
          )
        )
          throw new AppError('VALIDATION_ERROR', `问题 ${question.header} 的回答不符合选项要求`);
      }
    } else if (
      !('decision' in resolution) ||
      'content' in resolution ||
      !action.options.some((option) => option.id === resolution.decision)
    )
      throw new AppError('VALIDATION_ERROR', '请选择上游提供的合法选项');
  }

  private operation(row: OperationRow): Operation {
    const marker = this.store.marker(row.clientOperationId);
    return {
      clientOperationId: row.clientOperationId,
      kind: row.kind,
      target: row.target,
      status: row.state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.result === null ? {} : { result: row.result }),
      ...(row.error === null
        ? {}
        : { error: { ...row.error, clientOperationId: row.clientOperationId } }),
      ...(marker
        ? {
            execution: {
              operationId: marker.operationId,
              threadId: marker.threadId,
              ...(marker.turnId === null ? {} : { turnId: marker.turnId }),
              workspaceKey: marker.workspaceKey,
              codexEpoch: marker.codexEpoch,
              ended: marker.endedAt !== null,
            },
          }
        : {}),
      ...(row.reconciledAt
        ? {
            reconciliation: {
              at: row.reconciledAt,
              decision: row.reconciliationDecision ?? 'confirmed-ended',
            },
          }
        : {}),
    };
  }

  private asAppError(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof StoreConflict)
      return new AppError(
        error.code,
        error.message,
        409,
        error.threadId ? { threadId: error.threadId } : undefined,
      );
    return new AppError('INTERNAL_ERROR', error instanceof Error ? error.message : '未知错误', 500);
  }

  private publishThread(threadId: string): void {
    const thread = this.projection.get(threadId);
    if (!thread) return;
    this.events.publish('thread', this.threadView(thread), threadId);
    const summary = toThreadSummary(thread);
    const encoded = JSON.stringify(summary);
    if (this.summaries.get(threadId) === encoded) return;
    try {
      this.projects.assertOwnership(thread.projectId, thread.cwd);
    } catch {
      return;
    }
    this.summaries.set(threadId, encoded);
    this.events.publishSummary(summary);
  }

  private threadView(thread: ThreadView): ThreadView {
    const result = structuredClone(thread);
    const marker = this.store.activeForThread(thread.id);
    delete result.execution;
    if (marker)
      result.execution = {
        operationId: marker.operationId,
        threadId: marker.threadId,
        ...(marker.turnId === null ? {} : { turnId: marker.turnId }),
        workspaceKey: marker.workspaceKey,
        codexEpoch: marker.codexEpoch,
        ended: false,
      };
    return result;
  }

  private consume(event: CodexEvent): void {
    if (event.type === 'runtime') {
      this.compatibilityConfirmation(event.diagnostics);
      if (!event.diagnostics.ready || event.diagnostics.codexEpoch !== this.currentEpoch) {
        this.currentEpoch = event.diagnostics.codexEpoch;
        this.store.recover();
        this.projection.runtimeReset();
        for (const thread of this.projection.values()) this.publishThread(thread.id);
      }
      this.events.publish('runtime', this.getSystem());
      return;
    }
    if (event.type === 'thread') {
      try {
        this.projection.thread(this.normalize(event.thread), true);
        this.publishThread(event.thread.id);
      } catch {
        /* Events outside registered projects are not exposed. */
      }
      return;
    }
    if (event.type === 'action') {
      const action = event.action;
      if (action.codexEpoch !== this.codex.epoch) return;
      this.projection.action(action);
      if (action.threadId) this.publishThread(action.threadId);
      return;
    }
    if (event.type === 'actionResolved') {
      const action = this.projection.resolveAction(event.actionId, 'responded');
      if (action?.threadId) this.publishThread(action.threadId);
      return;
    }
    const thread = this.projection.get(event.threadId);
    if (!thread) return;
    if (event.type === 'threadStatus') {
      // Idle/notLoaded is not proof that an uncertain execution finished.
      if (this.store.activeForThread(thread.id)?.state !== 'unknown') thread.status = event.status;
      this.projection.touch(thread.id);
    } else if (event.type === 'turn') {
      this.projection.turn(thread.id, event.turn);
      const marker = this.store.activeForThread(thread.id);
      if (marker?.codexEpoch === this.codex.epoch && marker.turnId === null)
        this.store.attachTurn(marker.operationId, event.turn.id);
      if (isTerminal(event.turn.status)) {
        this.store.finishTurn(thread.id, event.turn.id, this.codex.epoch);
        this.projection.expireTurn(thread.id, event.turn.id);
      }
    } else if (event.type === 'item') this.projection.item(thread.id, event.turnId, event.item);
    else if (event.type === 'delta')
      this.projection.delta(
        thread.id,
        event.turnId,
        event.itemId,
        event.field,
        event.delta,
        event.itemType,
      );
    else if (event.type === 'diff') {
      this.projection.diff(thread.id, event.turnId, event.diff);
    }
    this.publishThread(thread.id);
  }
}
