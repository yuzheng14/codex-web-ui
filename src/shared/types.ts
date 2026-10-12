/** Browser-safe application contract. Upstream RPC types stay in src/codex. */
export type RunStatus =
  | 'idle'
  | 'running'
  | 'waitingApproval'
  | 'waitingInput'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown';
export interface Settings {
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  canonicalRoot: string;
  workspaceKey: string;
  available: boolean;
  error?: string;
}
export interface FileChange {
  path: string;
  kind: string;
  diff: string;
}
export interface ItemView {
  id: string;
  type: string;
  status?: string;
  text?: string;
  command?: string;
  cwd?: string;
  output?: string;
  changes?: FileChange[];
  details?: unknown;
  truncated?: boolean;
  error?: string;
}
export interface TurnView {
  id: string;
  threadId: string;
  status: RunStatus;
  items: ItemView[];
  diff?: string;
  error?: string;
}
export interface ThreadView {
  id: string;
  projectId: string;
  cwd: string;
  source: string;
  title: string;
  status: RunStatus;
  turns: TurnView[];
  managed: boolean;
  updatedAt?: number;
  actions: PendingAction[];
  historyTruncated?: boolean;
  execution?: ExecutionMarker;
}
export interface Question {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[];
}
export interface ActionOption {
  id: string;
  label: string;
}
export interface PendingAction {
  blocking?: boolean;
  actionId: string;
  codexEpoch: string;
  rpcId: string | number;
  kind: 'command' | 'file' | 'questions' | 'network' | 'unsupported';
  threadId?: string;
  turnId?: string;
  status: 'pending' | 'responding' | 'responded' | 'expired';
  title: string;
  reason?: string;
  command?: string;
  cwd?: string;
  details?: unknown;
  options: ActionOption[];
  questions?: Question[];
}
export type ActionResolution = { decision: string } | { answers: Record<string, string[]> };
export interface OperationInput {
  clientOperationId: string;
}
export interface CreateThreadInput extends OperationInput {
  settings?: Settings;
}
export interface ResumeThreadInput extends CreateThreadInput {
  confirmExternalStopped?: boolean;
}
export interface StartTurnInput extends CreateThreadInput {
  text: string;
}
export interface SteerInput extends OperationInput {
  expectedTurnId: string;
  text: string;
}
export interface InterruptInput extends OperationInput {
  expectedTurnId: string;
}
export interface ResolveActionInput extends OperationInput {
  resolution: ActionResolution;
}
export interface ReconcileInput extends OperationInput {
  confirmEnded: true;
}
export type OperationStatus = 'accepted' | 'dispatching' | 'acknowledged' | 'failed' | 'unknown';
export interface ApiError {
  code: string;
  message: string;
  clientOperationId?: string;
  details?: unknown;
}
export interface ExecutionMarker {
  operationId: string;
  threadId: string;
  turnId?: string;
  workspaceKey: string;
  codexEpoch: string;
  ended: boolean;
}
export interface Operation {
  clientOperationId: string;
  kind: string;
  target: string;
  status: OperationStatus;
  result?: unknown;
  error?: ApiError;
  createdAt: number;
  updatedAt: number;
  execution?: ExecutionMarker;
  reconciliation?: { at: number; decision: string };
}
export interface ThreadPage {
  data: ThreadView[];
  nextCursor: string | null;
}
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
}
export interface SystemInfo {
  ready: boolean;
  connection: 'starting' | 'ready' | 'unavailable';
  codexVersion: string | null;
  verifiedVersion: string;
  compatibility: 'verified' | 'unverified' | 'unavailable';
  codexEpoch: string;
  authenticated: boolean | null;
  authMode: 'local' | 'cloudflare-access';
  models: ModelInfo[];
  capabilities: string[];
  error?: string;
  demo: boolean;
}
export interface Cursor {
  serverEpoch: string;
  seq: number;
}
export interface SubscribeMessage {
  type: 'subscribe';
  threadId: string;
  after?: Cursor;
}
export type ServerMessage =
  | { type: 'snapshot'; cursor: Cursor; threadId: string; data: ThreadView }
  | {
      type: 'event';
      cursor: Cursor;
      threadId?: string;
      kind: 'thread' | 'runtime' | 'operation';
      payload: ThreadView | SystemInfo | Operation;
    }
  | { type: 'error'; error: ApiError };
