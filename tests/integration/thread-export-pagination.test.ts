import { afterEach, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../../src/codex/adapter.js';
import { GatewayService } from '../../src/server/service.js';
import { harness } from './domain-helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('exports every turn and item across native history pagination with uncropped tool output', async () => {
  const resource = harness();
  cleanups.push(resource.close);
  const adapter = new CodexAdapter({
    binary: process.execPath,
    args: [
      '--import',
      'tsx',
      resolve('tests/fixtures/app-server.ts'),
      '--options',
      JSON.stringify({
        paginated: true,
        historyPageSize: 2,
        historyItemSummaries: true,
        history: { turns: 5, itemsPerTurn: 23, itemBytes: 2000 },
        logPath: join(resource.directory, 'requests.jsonl'),
      }),
    ],
  });
  cleanups.push(() => adapter.stop());
  await adapter.start();
  const thread = await adapter.createThread(resource.project);
  const service = new GatewayService({
    store: resource.store,
    projects: resource.projects,
    codex: adapter,
  });
  const exported = await service.exportThread(thread.id);
  expect(exported.markdown.match(/^## 第 \d+ 轮/gm)).toHaveLength(5);
  expect(exported.markdown.match(/### 工具：命令执行/g)).toHaveLength(5 * 23);
  expect(exported.markdown.match(new RegExp(`x{2000}`, 'g'))).toHaveLength(5 * 23);
  expect(exported.markdown).not.toContain('内容已截断');
});
