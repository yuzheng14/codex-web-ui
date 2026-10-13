/** Exercises the shipped entry from an unrelated cwd, with a deliberately absent Codex. */
import { mkdtemp, mkdir, writeFile, rm, cp, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
const root = await mkdtemp(join(tmpdir(), 'codex-production-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const address = probe.address();
if (!address || typeof address === 'string') throw new Error('port');
await new Promise<void>((done) => probe.close(() => done()));
const origin = `http://127.0.0.1:${address.port}`;
await mkdir(join(root, 'project'));
await cp(resolve('dist'), join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'package.json'), '{"type":"module"}');
await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
await writeFile(
  join(root, 'config.json'),
  JSON.stringify({
    port: address.port,
    publicOrigin: [origin],
    dataDir: './data',
    codex: { binary: join(root, 'intentionally-not-installed') },
    projects: [{ id: 'isolated', name: 'Isolated', path: join(root, 'project') }],
  }),
);
const child = spawn(
  process.execPath,
  [join(root, 'dist/server/main.js'), '--', '--config', join(root, 'config.json')],
  { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] },
);
let error = '';
child.stderr.on('data', (chunk: Buffer) => {
  error += chunk.toString();
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(error || 'Gateway exited');
    try {
      ready = (await fetch(origin + '/api/health')).ok;
    } catch {
      /* Waiting for listener. */
    }
    if (ready) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  if (!ready) throw new Error('Gateway did not start');
  const page = await fetch(origin, { headers: { accept: 'text/html' } });
  if (!page.ok || !(await page.text()).includes('root'))
    throw new Error('Packaged static page missing');
  const system = await (await fetch(origin + '/api/system')).json();
  if (system.ready || system.demo || system.connection !== 'unavailable')
    throw new Error('Missing Codex must be unavailable, never mocked');
  const projects = await (await fetch(origin + '/api/projects')).json();
  if (projects.data[0]?.id !== 'isolated') throw new Error('API unavailable');
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin });
  await once(ws, 'open');
  ws.close();
  await once(ws, 'close');
  console.log(
    'PASS: isolated production artifacts, packaged migrations, unrelated cwd, static/API/WS, missing-Codex diagnostics',
  );
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await rm(root, { recursive: true, force: true });
}
