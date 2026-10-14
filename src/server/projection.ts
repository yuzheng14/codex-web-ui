import type { ItemView, PendingAction, RunStatus, ThreadView, TurnView } from '../shared/types.js';

export const isActive = (status: RunStatus): boolean =>
  status === 'running' || status === 'waitingApproval' || status === 'waitingInput';
export const isTerminal = (status: RunStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'interrupted';

export class Projection {
  private readonly threads = new Map<string, ThreadView>();
  readonly actions = new Map<string, PendingAction>();
  private readonly revisions = new Map<string, number>();
  constructor(private readonly maxItemBytes = 2 * 1024 * 1024) {}

  get(threadId: string): ThreadView | undefined {
    return this.threads.get(threadId);
  }
  values(): ThreadView[] {
    return [...this.threads.values()];
  }
  revision(threadId: string): number {
    return this.revisions.get(threadId) ?? 0;
  }
  touch(threadId: string): void {
    this.revisions.set(threadId, this.revision(threadId) + 1);
  }

  thread(incoming: ThreadView, preserveCurrent = false): ThreadView {
    const current = this.threads.get(incoming.id);
    if (!current) {
      const thread = structuredClone(incoming);
      for (const turn of thread.turns) turn.items = turn.items.map((item) => this.limit(item));
      thread.actions = [...this.actions.values()].filter((action) => action.threadId === thread.id);
      this.threads.set(thread.id, thread);
    } else {
      const oldTurns = current.turns;
      const oldStatus = current.status;
      const oldTitle = current.title;
      Object.assign(current, incoming, { turns: oldTurns, actions: current.actions });
      if (preserveCurrent) {
        current.status = oldStatus;
        current.title = oldTitle;
      }
      for (const turn of incoming.turns) this.turn(incoming.id, turn, preserveCurrent);
    }
    this.touch(incoming.id);
    return this.threads.get(incoming.id)!;
  }

  turn(threadId: string, incoming: TurnView, preserveCurrent = false): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const current = thread.turns.find((turn) => turn.id === incoming.id);
    if (!current)
      thread.turns.push({
        ...structuredClone(incoming),
        items: incoming.items.map((item) => this.limit(item)),
      });
    else {
      const items = current.items;
      if (!preserveCurrent) Object.assign(current, incoming, { items });
      for (const item of incoming.items) this.item(threadId, incoming.id, item, preserveCurrent);
    }
    if (!preserveCurrent) thread.status = incoming.status;
    this.touch(threadId);
  }

  item(threadId: string, turnId: string, item: ItemView, preserveCurrent = false): void {
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (!turn) return;
    const index = turn.items.findIndex((entry) => entry.id === item.id);
    if (index < 0) turn.items.push(this.limit(item));
    else if (!preserveCurrent) turn.items[index] = this.limit(item);
    this.touch(threadId);
  }

  delta(
    threadId: string,
    turnId: string,
    itemId: string,
    field: 'text' | 'output',
    delta: string,
    itemType?: string,
  ): void {
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (!turn) return;
    let item = turn.items.find((entry) => entry.id === itemId);
    if (!item) {
      item = {
        id: itemId,
        type: itemType ?? (field === 'text' ? 'agentMessage' : 'commandExecution'),
      };
      turn.items.push(item);
    }
    if (item.truncated) return;
    item[field] = (item[field] ?? '') + delta;
    Object.assign(item, this.limit(item));
    this.touch(threadId);
  }

  diff(threadId: string, turnId: string, diff: string): void {
    const turn = this.threads.get(threadId)?.turns.find((entry) => entry.id === turnId);
    if (turn) turn.diff = this.clip(diff).value;
    this.touch(threadId);
  }

  action(action: PendingAction): void {
    this.actions.set(action.actionId, action);
    const thread = action.threadId ? this.threads.get(action.threadId) : undefined;
    if (thread) {
      thread.actions = [...this.actions.values()].filter((entry) => entry.threadId === thread.id);
      this.updateActionStatus(thread);
      this.touch(thread.id);
    }
  }

  resolveAction(actionId: string, status: PendingAction['status']): PendingAction | undefined {
    const action = this.actions.get(actionId);
    if (!action) return undefined;
    action.status = status;
    const thread = action.threadId ? this.threads.get(action.threadId) : undefined;
    if (thread) {
      this.updateActionStatus(thread);
      this.touch(thread.id);
    }
    return action;
  }

  expireTurn(threadId: string, turnId: string): void {
    for (const action of this.actions.values())
      if (
        action.threadId === threadId &&
        action.turnId === turnId &&
        (action.status === 'pending' || action.status === 'responding')
      )
        this.resolveAction(action.actionId, 'expired');
  }

  runtimeReset(): void {
    for (const action of this.actions.values())
      if (action.status === 'pending' || action.status === 'responding')
        this.resolveAction(action.actionId, 'expired');
    for (const thread of this.threads.values()) {
      thread.managed = false;
      if (isActive(thread.status)) thread.status = 'unknown';
      for (const turn of thread.turns) if (isActive(turn.status)) turn.status = 'unknown';
      this.touch(thread.id);
    }
  }

  private updateActionStatus(thread: ThreadView): void {
    const active = thread.actions.filter(
      (action) =>
        action.blocking !== false &&
        (action.status === 'pending' || action.status === 'responding'),
    );
    const turn = [...thread.turns].reverse().find((entry) => isActive(entry.status));
    if (!turn) return;
    const status = active.some(
      (action) => action.kind === 'questions' || action.kind === 'elicitation',
    )
      ? 'waitingInput'
      : active.length > 0
        ? 'waitingApproval'
        : 'running';
    thread.status = status;
    turn.status = status;
  }

  private limit(item: ItemView): ItemView {
    const result = structuredClone(item);
    for (const field of ['text', 'output', 'command'] as const) {
      const value = result[field];
      if (value) {
        const clipped = this.clip(value);
        result[field] = clipped.value;
        if (clipped.truncated) result.truncated = true;
      }
    }
    if (result.changes)
      result.changes = result.changes.map((change) => {
        const clipped = this.clip(change.diff);
        if (clipped.truncated) result.truncated = true;
        return { ...change, diff: clipped.value };
      });
    if (result.details !== undefined) {
      const clipped = this.clip(JSON.stringify(result.details));
      if (clipped.truncated) {
        result.details = clipped.value;
        result.truncated = true;
      }
    }
    return result;
  }

  private clip(value: string): { value: string; truncated: boolean } {
    if (Buffer.byteLength(value) <= this.maxItemBytes) return { value, truncated: false };
    // Iterating code points avoids a half UTF-8 character at the truncation boundary.
    let kept = '';
    let bytes = 0;
    for (const point of value) {
      bytes += Buffer.byteLength(point);
      if (bytes > this.maxItemBytes) break;
      kept += point;
    }
    return { value: `${kept}\n[输出已截断]`, truncated: true };
  }
}
