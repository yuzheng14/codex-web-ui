import { createServer } from 'node:http';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { acquireInstanceLock } from '../server/instance-lock.js';
import { loadConfig } from '../server/config.js';
import { startGateway } from '../server/main.js';
import { packageInfo, paths } from './paths.js';

export async function runDaemon(configPath: string) {
  const location = paths(configPath);
  await mkdir(location.state, { recursive: true, mode: 0o700 });
  const release = await acquireInstanceLock(location.state);
  let config: Awaited<ReturnType<typeof loadConfig>>;
  let runtime: Awaited<ReturnType<typeof startGateway>> | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('content-type', 'application/json');
      if (request.method !== 'POST') throw new Error('Expected POST');
      if (request.url === '/status') {
        response.end(
          JSON.stringify({
            version: packageInfo.version,
            pid: process.pid,
            origin: config.publicOrigin[0],
            configPath,
            dataDir: config.dataDir,
          }),
        );
      } else if (request.url === '/stop') {
        await stop(() => response.end(JSON.stringify({ stopped: true })));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Unknown control action' }));
      }
    })().catch((error: unknown) => {
      response.statusCode = 400;
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Control failed' }),
      );
    });
  });
  let stopping: Promise<void> | undefined;
  const stop = (respond?: () => void) =>
    (stopping ??= (async () => {
      await runtime?.close();
      await release();
      respond?.();
      await new Promise<void>((done) => server.close(() => done()));
      if (process.platform !== 'win32') await rm(location.socket, { force: true });
    })());
  try {
    config = await loadConfig({ configPath, development: false });
    runtime = await startGateway(config);
    if (process.platform !== 'win32') await rm(location.socket, { force: true });
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(location.socket, done);
    });
    if (process.platform !== 'win32') await chmod(location.socket, 0o600);
    console.log(`Covro ${packageInfo.version} listening on ${config.publicOrigin[0]}`);
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  } catch (error) {
    await runtime?.close();
    await release();
    throw error;
  }
}
