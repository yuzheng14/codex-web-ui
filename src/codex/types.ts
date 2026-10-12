import type {
  ActionResolution,
  ItemView,
  PendingAction,
  RunStatus,
  Settings,
  SystemInfo,
  ThreadPage,
  ThreadView,
  TurnView,
} from '../shared/types.js';

export type CodexDiagnostics = Omit<SystemInfo, 'authMode' | 'demo'>;
export type CodexEvent =
  | { type: 'thread'; thread: ThreadView }
  | { type: 'threadStatus'; threadId: string; status: RunStatus }
  | { type: 'turn'; threadId: string; turn: TurnView }
  | { type: 'item'; threadId: string; turnId: string; item: ItemView }
  | {
      type: 'delta';
      threadId: string;
      turnId: string;
      itemId: string;
      field: 'text' | 'output';
      delta: string;
      itemType: string;
    }
  | { type: 'diff'; threadId: string; turnId: string; diff: string }
  | { type: 'action'; action: PendingAction }
  | { type: 'actionResolved'; actionId: string }
  | { type: 'runtime'; diagnostics: CodexDiagnostics };
export interface CodexClient {
  readonly epoch: string;
  readonly pid: number | undefined;
  readonly ready: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  diagnostics(): CodexDiagnostics;
  onEvent(listener: (event: CodexEvent) => void): () => void;
  listThreads(cwd: string, cursor?: string): Promise<ThreadPage>;
  readThread(id: string): Promise<ThreadView>;
  createThread(cwd: string, settings?: Settings): Promise<ThreadView>;
  resumeThread(id: string, cwd: string, settings?: Settings): Promise<ThreadView>;
  startTurn(id: string, cwd: string, text: string, settings?: Settings): Promise<TurnView>;
  steerTurn(id: string, turnId: string, text: string): Promise<{ turnId: string }>;
  interruptTurn(id: string, turnId: string): Promise<void>;
  respond(actionId: string, resolution: ActionResolution): Promise<void>;
}
