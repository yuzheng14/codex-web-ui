const scheme = /^[a-z][a-z\d+.-]*:/i;
const unsafePath = (value: string) =>
  Array.from(value).some(
    (character) =>
      character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

/** A server filesystem path, never a browser URL or an authorization decision. */
export function localFilePath(destination: string): string | undefined {
  if (!destination || destination !== destination.trim() || unsafePath(destination))
    return undefined;
  let encodedPath: string;
  if (/^file:/i.test(destination)) {
    // Reject host shares, credentials, and malformed file: forms before URL parsing
    // can normalize them into something that resembles a local path.
    if (!/^file:\/\/(?:localhost)?\//i.test(destination)) return undefined;
    try {
      const url = new URL(destination);
      if (url.hostname && url.hostname !== 'localhost') return undefined;
      encodedPath = url.pathname;
    } catch {
      return undefined;
    }
  } else {
    if (scheme.test(destination) || destination.startsWith('//')) return undefined;
    encodedPath = destination.split(/[?#]/, 1)[0] ?? '';
  }
  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    return undefined;
  }
  if (
    !path ||
    path !== path.trim() ||
    path.startsWith('//') ||
    scheme.test(path) ||
    unsafePath(path)
  )
    return undefined;
  return path;
}

/** Resolve decoded relative destinations against the previewed file, not the session cwd. */
export function relativeToFile(path: string, baseFile?: string): string {
  return baseFile && !path.startsWith('/')
    ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) + path
    : path;
}

export function localPreviewPath(destination: string): string | undefined {
  // Codex file references can include a source line suffix.
  const path = localFilePath(destination.replace(/:(\d+)(?::\d+)?$/, ''));
  return path && /\.(md|markdown|json)$/i.test(path) ? path : undefined;
}

export function localPreviewUrl(threadId: string, path: string): string {
  const format = /\.json$/i.test(path) ? 'json' : 'markdown';
  return `/api/threads/${encodeURIComponent(threadId)}/${format}?${new URLSearchParams({ path })}`;
}
