/** Kept below the Codex stdin budget, including base64 and the maximum task text. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const IMAGE_REQUEST_BYTES = 4 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Accept only bounded inline raster images; never fetch URLs or read server paths. */
export function imageDataBytes(value: string): number | undefined {
  if (value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32) return;
  const comma = value.indexOf(',');
  if (!/^data:image\/(png|jpeg|webp|gif);base64$/.test(value.slice(0, comma))) return;
  const data = value.slice(comma + 1);
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return;
  const bytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  return bytes <= MAX_IMAGE_BYTES ? bytes : undefined;
}
