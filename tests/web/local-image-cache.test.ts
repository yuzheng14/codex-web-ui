import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/web/lib/api';
import { LocalImageCache, LOCAL_IMAGE_FRESH_MS } from '../../src/web/lib/local-image-cache';
import { fetchLocalImage } from '../../src/web/lib/local-images';

vi.mock('../../src/web/lib/local-images', () => ({ fetchLocalImage: vi.fn() }));
const fetchImage = vi.mocked(fetchLocalImage);
let cache: LocalImageCache;
let nextUrl: number;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${++nextUrl}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  fetchImage.mockReset().mockResolvedValue(new Blob(['image']));
  cache = new LocalImageCache('thread');
});
afterEach(() => {
  cache.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('shares concurrent loads and reuses a fresh image without another request or URL', async () => {
  const first = cache.load('image.png');
  expect(cache.load('image.png')).toBe(first);
  await first;
  vi.advanceTimersByTime(LOCAL_IMAGE_FRESH_MS - 1);
  await cache.load('image.png');
  expect(fetchImage).toHaveBeenCalledTimes(1);
  expect(fetchImage).toHaveBeenCalledWith('thread', 'image.png', expect.any(AbortSignal));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(cache.snapshot('image.png')).toEqual({ src: 'blob:image-1' });
});

it('keeps a stale image visible until a single background revalidation replaces it', async () => {
  await cache.load('image.png');
  const listener = vi.fn();
  const unsubscribe = cache.subscribe('image.png', listener);
  let resolve!: (blob: Blob) => void;
  fetchImage.mockReturnValueOnce(new Promise((done) => (resolve = done)));
  vi.advanceTimersByTime(LOCAL_IMAGE_FRESH_MS);
  const pending = cache.load('image.png');
  expect(cache.load('image.png')).toBe(pending);
  expect(cache.snapshot('image.png')).toEqual({ src: 'blob:image-1' });
  expect(listener).not.toHaveBeenCalled();
  resolve(new Blob(['updated']));
  await pending;
  expect(cache.snapshot('image.png')).toEqual({ src: 'blob:image-2' });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-1');
  unsubscribe();
});

it.each([401, 403, 404, 415])('clears stale image bytes on an HTTP %s failure', async (status) => {
  await cache.load('image.png');
  vi.advanceTimersByTime(LOCAL_IMAGE_FRESH_MS);
  fetchImage.mockRejectedValueOnce(
    new HttpError(status, { code: 'IMAGE_FAILED', message: 'gone' }),
  );
  await cache.load('image.png');
  expect(cache.snapshot('image.png')).toEqual({ error: expect.any(String) });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-1');
  await cache.load('image.png', true);
  expect(cache.snapshot('image.png')).toEqual({ src: 'blob:image-2' });
});

it('lets explicit retries bypass freshness and ignores decoding failures from replaced images', async () => {
  await cache.load('image.png');
  await cache.load('image.png', true);
  cache.fail('image.png', 'blob:image-1', 'late error');
  expect(cache.snapshot('image.png')).toEqual({ src: 'blob:image-2' });
  cache.fail('image.png', 'blob:image-2', 'cannot decode');
  expect(cache.snapshot('image.png')).toEqual({ error: 'cannot decode' });
  await cache.load('image.png', true);
  expect(cache.snapshot('image.png')).toEqual({ src: 'blob:image-3' });
});

it('clears the provider cache, aborts pending work and ignores late responses', async () => {
  await cache.load('image.png');
  let resolve!: (blob: Blob) => void;
  fetchImage.mockReturnValueOnce(new Promise((done) => (resolve = done)));
  const pending = cache.load('pending.png');
  const signal = fetchImage.mock.calls.at(-1)![2];
  cache.clear();
  expect(signal.aborted).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-1');
  resolve(new Blob(['late']));
  await pending;
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(cache.snapshot('pending.png')).toEqual({});
  // React StrictMode can clean up and restart effects with the same store.
  await cache.load('image.png');
  expect(cache.snapshot('image.png')).toEqual({ src: 'blob:image-2' });
});

it('reports timeouts and permits retry', async () => {
  fetchImage.mockImplementationOnce(
    (_thread, _path, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const pending = cache.load('image.png');
  await vi.advanceTimersByTimeAsync(35_000);
  await pending;
  expect(cache.snapshot('image.png')).toEqual({ error: expect.any(String) });
  await cache.load('image.png', true);
  expect(cache.snapshot('image.png').src).toBeDefined();
});

it('evicts least recently used idle entries while keeping mounted previews valid', async () => {
  const unsubscribe = cache.subscribe('pinned.png', () => {});
  await cache.load('pinned.png');
  for (let i = 0; i < 32; i++) await cache.load(`${i}.png`);
  await cache.load('0.png');
  await cache.load('extra.png');
  expect(cache.snapshot('pinned.png').src).toBe('blob:image-1');
  expect(cache.snapshot('0.png').src).toBeDefined();
  expect(cache.snapshot('1.png')).toEqual({});
  unsubscribe();
  expect(cache.snapshot('pinned.png')).toEqual({});
});

it('bounds retained Blob bytes as well as entry count', async () => {
  const large = new Blob(['image']);
  Object.defineProperty(large, 'size', { value: 40 * 1024 * 1024 });
  fetchImage.mockResolvedValue(large);
  await cache.load('first.png');
  await cache.load('second.png');
  expect(cache.snapshot('first.png')).toEqual({});
  expect(cache.snapshot('second.png').src).toBeDefined();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-1');
});

it('isolates the same path between conversation providers', async () => {
  const other = new LocalImageCache('other-thread');
  await cache.load('image.png');
  await other.load('image.png');
  expect(fetchImage.mock.calls.map(([thread]) => thread)).toEqual(['thread', 'other-thread']);
  cache.clear();
  expect(other.snapshot('image.png')).toEqual({ src: 'blob:image-2' });
  other.clear();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-2');
});
