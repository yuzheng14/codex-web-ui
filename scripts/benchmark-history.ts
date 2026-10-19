/** Reproducible fixture-backed history read benchmark; never uses personal Codex history. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../src/codex/adapter.js';

const directory = await mkdtemp(join(tmpdir(), 'covro-history-benchmark-'));
const results = [];
try {
  for (const mode of ['full', 'paged'] as const) {
    const logPath = join(directory, `${mode}.jsonl`);
    const adapter = new CodexAdapter({
      binary: process.execPath,
      args: [
        '--import',
        'tsx',
        resolve('tests/fixtures/app-server.ts'),
        '--options',
        JSON.stringify({
          paginated: true,
          logPath,
          history: { turns: 125, itemsPerTurn: 3, itemBytes: 2000 },
        }),
      ],
    });
    try {
      await adapter.start();
      const thread = await adapter.createThread(directory);
      const started = performance.now();
      const view = await (mode === 'full'
        ? adapter.readThread(thread.id)
        : adapter.readThreadPage(thread.id));
      const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
      const rpcRequests = (await readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method?: string })
        .filter((entry) =>
          ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(entry.method ?? ''),
        ).length;
      results.push({
        mode,
        elapsedMs,
        rpcRequests,
        turns: view.turns.length,
        bytes: Buffer.byteLength(JSON.stringify(view)),
      });
    } finally {
      await adapter.stop();
    }
  }
  console.log(
    JSON.stringify({ fixture: { turns: 125, itemsPerTurn: 3, itemBytes: 2000 }, results }, null, 2),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
