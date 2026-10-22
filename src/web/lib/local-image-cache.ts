import { message } from '../i18n/messages';
import { fetchLocalImage } from './local-images';
import { readableError } from './utils';

export const LOCAL_IMAGE_FRESH_MS = 30_000;
const MAX_IDLE_IMAGES = 32;
const MAX_IDLE_BYTES = 64 * 1024 * 1024;

export type ImageState = { src?: string; error?: string };
export const emptyImageState: ImageState = {};
type PendingImage = { controller: AbortController; promise: Promise<void> };
type Entry = {
  state: ImageState;
  checkedAt: number;
  bytes: number;
  listeners: Set<() => void>;
  pending?: PendingImage;
};

/** Owned by one preview provider; never shared across conversations or persisted. */
export class LocalImageCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly threadId: string) {}

  snapshot(path: string): ImageState {
    return this.entries.get(path)?.state ?? emptyImageState;
  }

  subscribe(path: string, listener: () => void) {
    const entry = this.entry(path);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      this.trim();
    };
  }

  load(path: string, force = false): Promise<void> {
    const entry = this.entry(path);
    if (entry.pending) return entry.pending.promise;
    if (!force && entry.state.src && Date.now() - entry.checkedAt < LOCAL_IMAGE_FRESH_MS)
      return Promise.resolve();

    // Keep the last successful image visible while revalidating it in the background.
    if (entry.state.error) this.publish(entry, emptyImageState);
    const controller = new AbortController();
    const pending: PendingImage = { controller, promise: Promise.resolve() };
    entry.pending = pending;
    const current = () => this.entries.get(path) === entry && entry.pending === pending;
    const timeout = setTimeout(
      () => controller.abort(new Error(message('preview:image_loading_timed_out_please_retry'))),
      35_000,
    );
    pending.promise = fetchLocalImage(this.threadId, path, controller.signal)
      .then((blob) => {
        if (!current() || controller.signal.aborted) return;
        const previous = entry.state.src;
        entry.bytes = blob.size;
        entry.checkedAt = Date.now();
        this.publish(entry, { src: URL.createObjectURL(blob) });
        if (previous) URL.revokeObjectURL(previous);
      })
      .catch((error: unknown) => {
        if (current()) this.reject(entry, readableError(error));
      })
      .finally(() => {
        clearTimeout(timeout);
        if (current()) {
          entry.pending = undefined;
          this.trim();
        }
      });
    return pending.promise;
  }

  fail(path: string, src: string | undefined, error: string) {
    const entry = this.entries.get(path);
    // An old <img> can report a decoding failure after a replacement has arrived.
    if (entry && entry.state.src === src) this.reject(entry, error);
  }

  clear() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      entry.pending?.controller.abort();
      if (entry.state.src) URL.revokeObjectURL(entry.state.src);
      this.publish(entry, emptyImageState);
    }
  }

  private entry(path: string): Entry {
    const entry = this.entries.get(path) ?? {
      state: emptyImageState,
      checkedAt: 0,
      bytes: 0,
      listeners: new Set(),
    };
    // Map insertion order supplies LRU order without retaining another index.
    this.entries.delete(path);
    this.entries.set(path, entry);
    return entry;
  }

  private publish(entry: Entry, state: ImageState) {
    entry.state = state;
    for (const listener of entry.listeners) listener();
  }

  private reject(entry: Entry, error: string) {
    const previous = entry.state.src;
    entry.bytes = 0;
    entry.checkedAt = 0;
    this.publish(entry, { error });
    if (previous) URL.revokeObjectURL(previous);
  }

  private trim() {
    // Mounted thumbnails and open dialogs pin their URLs. Bound only retained,
    // unused images; evicting a mounted image would break its current preview.
    const idle = [...this.entries].filter(([, entry]) => entry.listeners.size === 0);
    let count = idle.length;
    let bytes = idle.reduce((sum, [, entry]) => sum + entry.bytes, 0);
    for (const [path, entry] of idle) {
      if (count <= MAX_IDLE_IMAGES && bytes <= MAX_IDLE_BYTES) break;
      this.entries.delete(path);
      entry.pending?.controller.abort();
      if (entry.state.src) URL.revokeObjectURL(entry.state.src);
      count--;
      bytes -= entry.bytes;
    }
  }
}
