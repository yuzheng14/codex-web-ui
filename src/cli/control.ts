import { request } from 'node:http';
import type { CovroPaths } from './paths.js';

/** Local owner control uses a private socket, never the public HTTP authentication boundary. */
export function control<T = unknown>(
  location: CovroPaths,
  action: string,
  input: object = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(input);
    const outgoing = request(
      {
        socketPath: location.socket,
        path: `/${action}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(requestBody),
        },
      },
      (incoming) => {
        let body = '';
        incoming.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 256 * 1024) incoming.destroy(new Error('Control response too large'));
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          try {
            const result = JSON.parse(body) as T & { error?: string };
            if (incoming.statusCode !== 200)
              reject(new Error(result.error ?? 'Control request failed'));
            else resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.setTimeout(15_000, () => outgoing.destroy(new Error('Covro control timed out')));
    outgoing.on('error', reject);
    outgoing.end(requestBody);
  });
}
export function isNotRunning(error: unknown) {
  return ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '');
}
