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
/** Values reported by Codex; null means unset or unavailable, never a guessed default. */
export interface RuntimeSettings {
  model: string | null;
  reasoningEffort: string | null;
  sandbox?: Settings['sandbox'] | 'external-sandbox' | null;
  approvalPolicy?: Settings['approvalPolicy'] | 'granular' | null;
  approvalReviewer?: string | null;
  networkAccess?: boolean | null;
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
export interface CreateProjectInput {
  path: string;
  name?: string;
}
export interface RenameProjectInput {
  name: string;
}
export interface FileChange {
  path: string;
  kind: string;
  diff: string;
}
/** Observed automatic review only; it is never a request for user authorization. */
export interface AutoReviewView {
  reviewId: string;
  targetItemId?: string;
  status: 'inProgress' | 'approved' | 'denied' | 'timedOut' | 'aborted' | 'unknown';
  actionLabel: string;
  actionSummary: string;
  cwd?: string;
  rationale?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  userAuthorization?: 'unknown' | 'low' | 'medium' | 'high';
  startedAtMs: number;
  completedAtMs?: number;
}
export interface ItemView {
  id: string;
  type: string;
  status?: string;
  text?: string;
  images?: string[];
  imageCount?: number;
  command?: string;
  cwd?: string;
  output?: string;
  changes?: FileChange[];
  details?: unknown;
  truncated?: boolean;
  error?: string;
  autoReview?: AutoReviewView;
}
export interface TurnView {
  id: string;
  threadId: string;
  status: RunStatus;
  items: ItemView[];
  diff?: string;
  error?: string;
  /** Codex's upstream retry state; independent of the browser's gateway connection. */
  reconnect?: { status: 'retrying' | 'failed'; message: string };
}
export interface ThreadView {
  id: string;
  runtimeSettings?: RuntimeSettings;
  forkedFromId?: string;
  projectId: string;
  cwd: string;
  source: string;
  title: string;
  status: RunStatus;
  turns: TurnView[];
  managed: boolean;
  /** Last definite resume failure; cleared on retry, successful acquisition or runtime reset. */
  resumeError?: ApiError;
  updatedAt?: number;
  actions: PendingAction[];
  historyTruncated?: boolean;
  execution?: ExecutionMarker;
}
export type ThreadSummary = Pick<
  ThreadView,
  'id' | 'forkedFromId' | 'projectId' | 'source' | 'title' | 'status' | 'managed' | 'updatedAt'
> & {
  pendingActionCount: number;
  lastTurnStatus?: RunStatus;
};
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
export type ElicitationValue = string | number | boolean | string[];
export interface ElicitationField {
  name: string;
  title: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multiEnum';
  required: boolean;
  options?: { value: string; label: string }[];
  default?: ElicitationValue;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
}
export interface ElicitationRequest {
  serverName: string;
  mode: 'form' | 'url';
  url?: string;
  fields?: ElicitationField[];
  schemaError?: string;
}
export interface PermissionRequest {
  network?: boolean | null;
  fileSystem?: {
    read: string[];
    write: string[];
    entries: { path: string; access: string }[];
    globScanMaxDepth?: number;
  };
}
export interface PendingAction {
  blocking?: boolean;
  actionId: string;
  codexEpoch: string;
  rpcId: string | number;
  kind:
    'command' | 'file' | 'questions' | 'network' | 'permissions' | 'elicitation' | 'unsupported';
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
  permissionRequest?: PermissionRequest;
  elicitation?: ElicitationRequest;
}
export type ActionResolution =
  | { decision: string; content?: Record<string, ElicitationValue> }
  | { answers: Record<string, string[]> };
export interface OperationInput {
  clientOperationId: string;
}
export interface ConfirmCompatibilityInput extends OperationInput {
  codexEpoch: string;
  codexVersion: string;
  verifiedVersion: string;
  confirm: true;
}
export interface CreateThreadInput extends OperationInput {
  settings?: Settings;
}
export type ForkThreadInput = CreateThreadInput;
export interface ResumeThreadInput extends CreateThreadInput {
  /** Kept for older clients; writer ownership is now checked by Codex, not this flag. */
  confirmExternalStopped?: boolean;
}
export interface TaskMessage {
  text: string;
  images?: string[];
}
export interface StartTurnInput extends CreateThreadInput, TaskMessage {}
export interface SteerInput extends OperationInput, TaskMessage {
  expectedTurnId: string;
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
export interface ThreadSummaryPage {
  data: ThreadSummary[];
  nextCursor: string | null;
  cursor: Cursor;
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
  compatibilityConfirmation: 'not-required' | 'required' | 'confirmed';
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
      kind: 'thread' | 'threadSummary' | 'runtime' | 'operation' | 'projects';
      payload: ThreadView | ThreadSummary | SystemInfo | Operation | Project[];
    }
  | { type: 'error'; error: ApiError };
