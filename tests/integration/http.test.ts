import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile, cp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/codex/adapter.js';
import { parseConfig } from '../../src/server/config.js';
import { startGateway } from '../../src/server/main.js';
import type { Operation, ServerMessage, ThreadView } from '../../src/shared/types.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const root = await mkdtemp(join(tmpdir(), 'codex-http-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'));
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><title>Codex test</title>');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = parseConfig(
    {
      port: address.port,
      publicOrigin: origin,
      dataDir: join(root, 'data'),
      projects: [{ id: 'test', name: 'Test', path: join(root, 'project') }],
    },
    join(root, 'config.json'),
  );
  const codex = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({ turnDelayMs: 150, fragmentBytes: 11 }),
    ],
  });
  const runtime = await startGateway(config, { codex, staticDir: join(root, 'web') });
  cleanup.push(runtime.close);
  const post = async (path: string, body: unknown) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const connect = async () => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin });
    await once(ws, 'open');
    cleanup.push(async () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        await once(ws, 'close');
      }
    });
    return ws;
  };
  return { origin, runtime, post, connect };
}
function message(
  ws: WebSocket,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', listener);
      reject(new Error('WS message timeout'));
    }, 5000);
    const listener = (data: Buffer) => {
      const value = JSON.parse(data.toString()) as ServerMessage;
      if (predicate(value)) {
        clearTimeout(timer);
        ws.off('message', listener);
        resolve(value);
      }
    };
    ws.on('message', listener);
  });
}
it('runs through HTTP, survives all sockets closing, and reconnects from a snapshot with real IDs', async () => {
  const { origin, runtime, post, connect } = await setup();
  const createResponse = await post('/api/projects/test/threads', {
    clientOperationId: randomUUID(),
  });
  expect(createResponse.status).toBe(200);
  const create = (await createResponse.json()) as Operation;
  const threadId = (create.result as { threadId: string }).threadId;
  const ws = await connect();
  const first = message(ws, (m) => m.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'subscribe', threadId }));
  expect((await first).type).toBe('snapshot');
  const pid = runtime.codex.pid;
  const opId = randomUUID();
  const input = { clientOperationId: opId, text: '测试 HTTP 与恢复' };
  const [a, b] = await Promise.all([
    post(`/api/threads/${threadId}/turns`, input),
    post(`/api/threads/${threadId}/turns`, input),
  ]);
  expect([200, 202]).toContain(a.status);
  expect([200, 202]).toContain(b.status);
  ws.close();
  await once(ws, 'close');
  await expect
    .poll(
      async () =>
        ((await (await fetch(`${origin}/api/threads/${threadId}`)).json()) as ThreadView).turns[0]
          ?.status,
    )
    .toBe('completed');
  expect(runtime.codex.pid).toBe(pid);
  const reopened = await connect();
  const snapshot = message(reopened, (m) => m.type === 'snapshot');
  reopened.send(JSON.stringify({ type: 'subscribe', threadId }));
  const restored = await snapshot;
  if (restored.type !== 'snapshot') throw new Error('Expected snapshot');
  expect(restored.data.turns).toHaveLength(1);
  expect(restored.data.turns[0]?.items.some((i) => i.text === '模拟任务已完成。')).toBe(true);
  const conflict = await post(`/api/threads/${threadId}/turns`, { ...input, text: '不同请求' });
  expect(conflict.status).toBe(409);
});
it('rejects foreign origin before upgrade, validates JSON, and never serves SPA HTML for missing API/assets', async () => {
  const { origin, post } = await setup();
  const denied = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
    origin: 'https://attacker.test',
  });
  const rejected = await new Promise<number>((resolve, reject) => {
    denied.once('unexpected-response', (_req, res) => {
      const code = res.statusCode!;
      res.resume();
      denied.terminate();
      resolve(code);
    });
    denied.on('error', () => {});
    setTimeout(() => reject(new Error('No rejection')), 3000).unref();
  });
  expect(rejected).toBe(403);
  const wrong = await post('/api/projects/test/threads', {
    clientOperationId: randomUUID(),
    cwd: '/tmp',
  });
  expect(wrong.status).toBe(400);
  expect((await wrong.json()).error.code).toBe('VALIDATION_FAILED');
  for (const path of ['/api/missing', '/ws/missing', '/assets/missing.js']) {
    const response = await fetch(origin + path, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  }
  const navigation = await fetch(origin + '/thread/any', { headers: { accept: 'text/html' } });
  expect(navigation.status).toBe(200);
  expect(await navigation.text()).toContain('Codex test');
});
it('restores pending approval and accepts exactly one competing decision', async () => {
  const { origin, post, connect } = await setup();
  const created = (await (
    await post('/api/projects/test/threads', { clientOperationId: randomUUID() })
  ).json()) as Operation;
  const threadId = (created.result as { threadId: string }).threadId;
  await post(`/api/threads/${threadId}/turns`, {
    clientOperationId: randomUUID(),
    text: '[approval]',
  });
  await expect
    .poll(
      async () =>
        ((await (await fetch(`${origin}/api/threads/${threadId}`)).json()) as ThreadView).actions
          .length,
    )
    .toBe(1);
  const ws = await connect();
  const pending = message(ws, (m) => m.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'subscribe', threadId }));
  const snapshot = await pending;
  if (snapshot.type !== 'snapshot') throw new Error('snapshot');
  const action = snapshot.data.actions[0]!;
  expect(action.rpcId).toBe(0);
  expect(action.status).toBe('pending');
  const results = await Promise.all([
    post(`/api/actions/${action.actionId}/resolve`, {
      clientOperationId: randomUUID(),
      resolution: { decision: action.options[0]!.id },
    }),
    post(`/api/actions/${action.actionId}/resolve`, {
      clientOperationId: randomUUID(),
      resolution: { decision: action.options[0]!.id },
    }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  await expect
    .poll(
      async () =>
        ((await (await fetch(`${origin}/api/threads/${threadId}`)).json()) as ThreadView).turns[0]
          ?.status,
    )
    .toBe('completed');
});

it('fails migrations before launching Codex and releases the instance lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-migration-fail-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'));
  await cp(resolve('drizzle'), join(root, 'migrations'), { recursive: true });
  const sql = (await readdir(join(root, 'migrations'))).find((name) => name.endsWith('.sql'))!;
  await writeFile(join(root, 'migrations', sql), 'THIS IS NOT SQL;');
  const config = parseConfig(
    {
      dataDir: join(root, 'data'),
      projects: [{ id: 'test', name: 'Test', path: join(root, 'project') }],
    },
    join(root, 'config.json'),
  );
  const codex = new CodexAdapter({
    binary: process.execPath,
    args: ['--import', 'tsx', resolve('tests/fixtures/app-server.ts'), '--options', '{}'],
  });
  const start = vi.spyOn(codex, 'start');
  await expect(
    startGateway(config, { codex, migrationsDir: join(root, 'migrations') }),
  ).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
  const { acquireInstanceLock } = await import('../../src/server/instance-lock.js');
  const release = await acquireInstanceLock(config.dataDir);
  await release();
});
