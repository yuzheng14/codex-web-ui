import type { Cursor, Operation, ServerMessage, SystemInfo, ThreadView } from '../../shared/types';

export type ConnectionState =
  'connecting' | 'connected' | 'disconnected' | 'authenticationRequired';
export interface Projection {
  data: ThreadView;
  cursor: Cursor;
}

/** The cache owns both projection and cursor; cursors are deliberately never written to storage. */
export class ProjectionCache {
  private readonly threads = new Map<string, Projection>();
  private runtimeCursor: Cursor | undefined;
  get(threadId: string) {
    return this.threads.get(threadId);
  }
  apply(message: ServerMessage): boolean {
    if (message.type === 'error') return true;
    if (message.type === 'snapshot') {
      const previous = this.threads.get(message.threadId);
      if (
        previous?.cursor.serverEpoch === message.cursor.serverEpoch &&
        previous.cursor.seq > message.cursor.seq
      )
        return false;
      this.threads.set(message.threadId, { data: message.data, cursor: message.cursor });
      return true;
    }
    if (message.kind === 'thread' && message.threadId) {
      const previous = this.threads.get(message.threadId);
      // A delta/event never establishes a projection. The subscription must get a snapshot first.
      if (
        !previous ||
        previous.cursor.serverEpoch !== message.cursor.serverEpoch ||
        previous.cursor.seq >= message.cursor.seq
      )
        return false;
      this.threads.set(message.threadId, {
        data: message.payload as ThreadView,
        cursor: message.cursor,
      });
      return true;
    }
    if (
      this.runtimeCursor?.serverEpoch === message.cursor.serverEpoch &&
      this.runtimeCursor.seq >= message.cursor.seq
    )
      return false;
    this.runtimeCursor = message.cursor;
    return true;
  }
}

export function reconnectDelay(attempt: number, random = Math.random) {
  return Math.min(30_000, 700 * 2 ** Math.min(attempt, 6)) * (0.75 + random() * 0.25);
}

interface Handlers {
  connection: (state: ConnectionState) => void;
  thread: (thread: ThreadView) => void;
  system: (system: SystemInfo) => void;
  operation: (operation: Operation) => void;
  error: (message: string) => void;
}

function isMessage(value: unknown): value is ServerMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const m = value as Record<string, unknown>;
  if (m.type === 'error')
    return Boolean(m.error && typeof m.error === 'object' && 'message' in m.error);
  if (!m.cursor || typeof m.cursor !== 'object') return false;
  const cursor = m.cursor as Record<string, unknown>;
  if (
    typeof cursor.serverEpoch !== 'string' ||
    typeof cursor.seq !== 'number' ||
    !Number.isSafeInteger(cursor.seq)
  )
    return false;
  const payload = (m.type === 'snapshot' ? m.data : m.payload) as
    Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return false;
  if (m.type === 'snapshot' || m.kind === 'thread')
    return (
      typeof m.threadId === 'string' &&
      typeof payload.id === 'string' &&
      Array.isArray(payload.turns) &&
      Array.isArray(payload.actions)
    );
  return m.type === 'event' && (m.kind === 'runtime' || m.kind === 'operation');
}

export class ThreadStream {
  readonly cache = new ProjectionCache();
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private stopped = true;
  private selected?: string;
  private blocked = false;

  constructor(private readonly handlers: Handlers) {}
  start() {
    this.stopped = false;
    window.addEventListener('online', this.retry);
    window.addEventListener('offline', this.offline);
    window.addEventListener('focus', this.retry);
    this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    window.removeEventListener('online', this.retry);
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('focus', this.retry);
    this.socket?.close();
    this.socket = undefined;
  }
  select(threadId?: string) {
    if (this.selected === threadId) return;
    this.selected = threadId;
    const cached = threadId ? this.cache.get(threadId) : undefined;
    if (cached) this.handlers.thread(cached.data);
    // One subscription per socket. Closing this transport only releases browser subscriptions.
    this.socket?.close();
    this.socket = undefined;
    clearTimeout(this.timer);
    this.connect();
  }
  retry = () => {
    if (
      this.stopped ||
      this.blocked ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    clearTimeout(this.timer);
    this.connect();
  };
  private offline = () => {
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.handlers.connection('disconnected');
  };
  private connect() {
    if (this.stopped || this.blocked) return;
    if (!navigator.onLine) {
      this.handlers.connection('disconnected');
      return;
    }
    this.handlers.connection(this.attempt === 0 ? 'connecting' : 'disconnected');
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    );
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return socket.close();
      this.attempt = 0;
      this.handlers.connection('connected');
      if (this.selected) {
        const cached = this.cache.get(this.selected);
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            threadId: this.selected,
            ...(cached ? { after: cached.cursor } : {}),
          }),
        );
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const value: unknown = JSON.parse(String(event.data));
        if (!isMessage(value)) {
          this.handlers.error('收到无法识别的服务器消息，请检查版本兼容性。');
          return;
        }
        if (!this.cache.apply(value)) return;
        if (value.type === 'error') {
          this.handlers.error(value.error.message);
          return;
        }
        if (value.type === 'snapshot' && value.threadId === this.selected)
          this.handlers.thread(value.data);
        if (value.type === 'event') {
          if (value.kind === 'thread' && value.threadId === this.selected)
            this.handlers.thread(value.payload as ThreadView);
          if (value.kind === 'runtime') this.handlers.system(value.payload as SystemInfo);
          if (value.kind === 'operation') this.handlers.operation(value.payload as Operation);
        }
      } catch {
        this.handlers.error('实时消息解析失败，请刷新会话快照。');
      }
    };
    socket.onclose = (event) => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = undefined;
      if (
        event.code === 4001 ||
        event.code === 4401 ||
        event.code === 4403 ||
        event.code === 1008
      ) {
        this.blocked = true;
        this.handlers.connection('authenticationRequired');
        return;
      }
      this.handlers.connection('disconnected');
      this.timer = setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
    };
    socket.onerror = () => {
      /* The close event schedules a single retry. */
    };
  }
}
