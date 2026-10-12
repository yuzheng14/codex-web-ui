import { randomUUID } from 'node:crypto';
import type { Cursor, Operation, ServerMessage, SystemInfo, ThreadView } from '../shared/types.js';

type BusinessEvent = Extract<ServerMessage, { type: 'event' }>;
type Listener = (message: ServerMessage) => void;

/** Synchronous snapshot+subscription forms one JS event-loop boundary. */
export class EventHub {
  readonly serverEpoch = randomUUID();
  private seq = 0;
  private discardedThrough = 0;
  private bytes = 0;
  private readonly events: { event: BusinessEvent; bytes: number }[] = [];
  private readonly listeners = new Set<{ threadId: string; send: Listener }>();
  private readonly runtimeListeners = new Set<Listener>();

  constructor(private readonly maxBytes = 16 * 1024 * 1024) {}

  cursor(): Cursor {
    return { serverEpoch: this.serverEpoch, seq: this.seq };
  }

  publish(
    kind: 'thread' | 'runtime' | 'operation',
    payload: ThreadView | SystemInfo | Operation,
    threadId?: string,
  ): void {
    const event: BusinessEvent = {
      type: 'event',
      cursor: { serverEpoch: this.serverEpoch, seq: ++this.seq },
      kind,
      payload: structuredClone(payload),
      ...(threadId === undefined ? {} : { threadId }),
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push({ event, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes && this.events.length > 0) {
      const removed = this.events.shift()!;
      this.bytes -= removed.bytes;
      this.discardedThrough = removed.event.cursor.seq;
    }
    for (const listener of this.listeners)
      if (!event.threadId || event.threadId === listener.threadId)
        this.deliver(listener.send, event);
    if (kind === 'runtime')
      for (const listener of this.runtimeListeners) this.deliver(listener, event);
  }

  subscribeRuntime(send: Listener): () => void {
    this.runtimeListeners.add(send);
    return () => {
      this.runtimeListeners.delete(send);
    };
  }

  subscribe(
    threadId: string,
    snapshot: () => ThreadView,
    after: Cursor | undefined,
    send: Listener,
  ): () => void {
    const replayable =
      after?.serverEpoch === this.serverEpoch &&
      after.seq >= this.discardedThrough &&
      after.seq <= this.seq;
    const queued: ServerMessage[] = [];
    let initializing = true;
    const listener = {
      threadId,
      send: (message: ServerMessage) => {
        if (initializing) queued.push(message);
        else send(message);
      },
    };
    this.listeners.add(listener);
    // No await may occur between reading the snapshot and registering the listener.
    let boundary = this.seq;
    if (replayable && after) {
      for (const { event } of [...this.events])
        if (
          event.cursor.seq > after.seq &&
          event.cursor.seq <= boundary &&
          (!event.threadId || event.threadId === threadId)
        )
          this.deliver(send, event);
    } else {
      const data = structuredClone(snapshot());
      boundary = this.seq;
      this.deliver(send, { type: 'snapshot', cursor: this.cursor(), threadId, data });
    }
    initializing = false;
    for (const message of queued)
      if (message.type === 'event' && message.cursor.seq > boundary) this.deliver(send, message);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private deliver(send: Listener, message: ServerMessage): void {
    // A closed or slow browser must never unwind the upstream event consumer.
    try {
      send(message);
    } catch {
      /* Transport closes or unsubscribes its own failed socket. */
    }
  }
}
