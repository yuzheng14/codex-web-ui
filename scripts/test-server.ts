/** Explicit fixture-backed browser test entry. Production never imports this module. */
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../src/codex/adapter.js';
import type { CodexClient, CodexDiagnostics, CodexEvent } from '../src/codex/types.js';
import { parseConfig } from '../src/server/config.js';
import { startGateway } from '../src/server/main.js';

/** Test-only diagnostics controls; the production adapter has no hook. */
class ControlledFixture implements CodexClient {
  private version = 'fixture-unverified-1';
  private unavailable = false;
  private readonly listeners = new Set<(event: CodexEvent) => void>();
  constructor(private readonly inner: CodexClient) {
    inner.onEvent((event) => {
      this.publish(
        event.type === 'runtime' ? { type: 'runtime', diagnostics: this.diagnostics() } : event,
      );
    });
  }
  get epoch() {
    return this.inner.epoch;
  }
  get pid() {
    return this.inner.pid;
  }
  get ready() {
    return this.inner.ready && !this.unavailable;
  }
  diagnostics(): CodexDiagnostics {
    return {
      ...this.inner.diagnostics(),
      codexVersion: this.version,
      compatibility: 'unverified',
      ready: this.ready,
      ...(this.unavailable
        ? { connection: 'unavailable' as const, error: '测试进程已不可用' }
        : {}),
    };
  }
  onEvent(listener: (event: CodexEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  start() {
    return this.inner.start();
  }
  stop() {
    return this.inner.stop();
  }
  listThreads: CodexClient['listThreads'] = (...args) => this.inner.listThreads(...args);
  readThread: CodexClient['readThread'] = (...args) => this.inner.readThread(...args);
  readThreadMetadata: CodexClient['readThreadMetadata'] = (...args) =>
    this.inner.readThreadMetadata(...args);
  createThread: CodexClient['createThread'] = (...args) => this.inner.createThread(...args);
  forkThread: CodexClient['forkThread'] = (...args) => this.inner.forkThread(...args);
  resumeThread: CodexClient['resumeThread'] = (...args) => this.inner.resumeThread(...args);
  startTurn: CodexClient['startTurn'] = (...args) => this.inner.startTurn(...args);
  steerTurn: CodexClient['steerTurn'] = (...args) => this.inner.steerTurn(...args);
  interruptTurn: CodexClient['interruptTurn'] = (...args) => this.inner.interruptTurn(...args);
  respond: CodexClient['respond'] = (...args) => this.inner.respond(...args);
  async reset(version = 'fixture-unverified-1') {
    await this.stop();
    this.version = version;
    this.unavailable = false;
    await this.start();
  }
  update(version: string | undefined, unavailable: boolean | undefined) {
    if (version !== undefined) this.version = version;
    if (unavailable !== undefined) this.unavailable = unavailable;
    this.publish({ type: 'runtime', diagnostics: this.diagnostics() });
  }
  private publish(event: CodexEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

const root = await mkdtemp(join(tmpdir(), 'codex-web-e2e-'));
const project = join(root, 'project');
const otherProject = join(root, 'other-project');
await mkdir(project);
await mkdir(otherProject);
const config = parseConfig(
  {
    port: 8788,
    publicOrigin: ['http://127.0.0.1:8788'],
    dataDir: join(root, 'data'),
    projects: [
      { id: 'fixture', name: '测试项目', path: project },
      { id: 'fixture-other', name: '另一个项目', path: otherProject },
      { id: 'fixture-unavailable', name: '不可用项目', path: join(root, 'missing-project') },
    ],
  },
  join(root, 'config.json'),
);
config.demo = true;
const codex = new ControlledFixture(
  new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ fragmentBytes: 7, turnDelayMs: 800 }),
    ],
  }),
);
const runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });

// Separate loopback control listener exists only in this explicit test entry. Requests from a
// browser Origin are refused. It never adds a route or bypass to the production gateway.
let controlling = Promise.resolve();
const control = createServer((request, response) => {
  void (async () => {
    if (
      request.method !== 'POST' ||
      request.url !== '/runtime' ||
      request.headers.origin ||
      request.headers['content-type'] !== 'application/json'
    ) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 4096) {
        response.writeHead(413).end();
        return;
      }
    }
    const input = JSON.parse(body) as { reset?: boolean; version?: string; unavailable?: boolean };
    if (
      input.version !== undefined &&
      (typeof input.version !== 'string' || input.version.length > 80)
    ) {
      response.writeHead(400).end();
      return;
    }
    if (input.unavailable !== undefined && typeof input.unavailable !== 'boolean') {
      response.writeHead(400).end();
      return;
    }
    const work = controlling.then(async () => {
      if (input.reset === true) await codex.reset(input.version);
      else codex.update(input.version, input.unavailable);
    });
    controlling = work.catch(() => {});
    await work;
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(runtime.service.getSystem()));
  })().catch((error: unknown) => {
    response.writeHead(500).end(error instanceof Error ? error.message : 'Fixture control failed');
  });
});
await new Promise<void>((resolveListening, reject) => {
  control.once('error', reject);
  control.listen(8789, '127.0.0.1', resolveListening);
});
console.log('Explicit fixture server: http://127.0.0.1:8788');
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  control.close();
  control.closeAllConnections();
  void runtime.close().finally(async () => {
    await rm(root, { recursive: true, force: true });
  });
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
