/** Explicit fixture-backed browser test entry. Production never imports this module. */
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../src/codex/adapter.js';
import { parseConfig } from '../src/server/config.js';
import { startGateway } from '../src/server/main.js';
const root = await mkdtemp(join(tmpdir(), 'codex-web-e2e-'));
const project = join(root, 'project');
await mkdir(project);
const config = parseConfig(
  {
    port: 8788,
    publicOrigin: 'http://127.0.0.1:8788',
    dataDir: join(root, 'data'),
    projects: [{ id: 'fixture', name: '测试项目', path: project }],
  },
  join(root, 'config.json'),
);
config.demo = true;
const codex = new CodexAdapter({
  binary: process.execPath,
  args: [
    '--import',
    'tsx',
    resolve('tests/fixtures/app-server.ts'),
    '--options',
    JSON.stringify({ fragmentBytes: 7, turnDelayMs: 800 }),
  ],
});
const runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
console.log('Explicit fixture server: http://127.0.0.1:8788');
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void runtime.close().finally(async () => {
    await rm(root, { recursive: true, force: true });
  });
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
