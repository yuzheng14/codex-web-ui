/** Explicit Chromium + real Codex smoke. Never imported by default tests or production. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';
import { CodexAdapter } from '../src/codex/adapter.js';
import { parseConfig } from '../src/server/config.js';
import { startGateway } from '../src/server/main.js';
import type { Operation } from '../src/shared/types.js';

const args = process.argv.slice(2).filter((argument) => argument !== '--');
if (!args.includes('--inference'))
  throw new Error(
    'Pass --inference to explicitly authorize this isolated real-Codex browser task.',
  );
const outputIndex = args.indexOf('--output');
const output = resolve(
  outputIndex >= 0 ? args[outputIndex + 1]! : 'docs/real-browser-verification.json',
);
const root = await mkdtemp(join(tmpdir(), 'codex-web-real-browser-'));
const project = join(root, 'project');
await mkdir(project);
const config = parseConfig(
  {
    port: 8790,
    publicOrigin: 'http://127.0.0.1:8790',
    dataDir: join(root, 'data'),
    projects: [{ id: 'smoke-browser', name: '真实浏览器验证', path: project }],
  },
  join(root, 'config.json'),
);
const codex = new CodexAdapter(config.codex);
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  mode: 'real Chromium browser + actual Codex; no simulator',
  inference: true,
  checks: [],
  tunnelVerified: false,
};
const checks = report.checks as string[];
let browser: Browser | undefined;
let runtime: Awaited<ReturnType<typeof startGateway>> | undefined;
let threadId: string | undefined;
let currentTurnId: string | undefined;
let pendingHumanAction = false;
let failed = false;
const unsubscribe = codex.onEvent((event) => {
  if (event.type === 'action' && event.action.status === 'pending') pendingHumanAction = true;
  if (event.type === 'turn' && event.threadId === threadId) currentTurnId = event.turn.id;
});

try {
  runtime = await startGateway(config, { codex, staticDir: resolve('dist/web') });
  const diagnostics = codex.diagnostics();
  report.codexVersion = diagnostics.codexVersion;
  report.authenticated = diagnostics.authenticated;
  report.compatibility = diagnostics.compatibility;
  assert.equal(
    diagnostics.authenticated,
    true,
    'Existing Codex authentication is required; no login changes are attempted.',
  );
  assert.equal(diagnostics.ready, true, 'Actual Codex app-server must be ready.');
  assert.equal(runtime.service.getSystem().demo, false);
  const initialPid = codex.pid;
  assert.ok(initialPid, 'The gateway must own a real app-server process.');
  browser = await chromium.launch();
  let page = await browser.newPage();
  await page.goto(config.publicOrigin);
  await expect(page.locator('.connection-badge')).toHaveText('实时连接正常');
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/projects/smoke-browser/threads'),
  );
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const created = (await (await createdResponse).json()) as Operation;
  threadId = (created.result as { threadId: string }).threadId;
  assert.ok(threadId);
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  await page.locator('.settings-panel > summary').click();
  await page.getByLabel('权限范围').selectOption('workspace-write');
  await page.getByLabel('审批策略').selectOption('on-request');
  await page.locator('.settings-panel > summary').click();
  const prompt =
    'This is an isolated real-browser smoke test. Use apply_patch to create only smoke-browser.txt in the current directory containing exactly Codex browser smoke test followed by one newline. Do not read unrelated files or directories, do not access the network, and do not start background processes. Then reply with exactly BROWSER_SMOKE_COMPLETE.';
  await page.getByRole('textbox', { name: '任务内容' }).fill(prompt);
  const startedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/api/threads/${threadId}/turns`),
  );
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const started = (await (await startedResponse).json()) as Operation;
  assert.equal(started.status, 'acknowledged');
  currentTurnId = (started.result as { turnId: string }).turnId;
  const beforeClose = await runtime.service.getThread(threadId);
  report.activeWhenBrowserClosed = ['running', 'waitingApproval', 'waitingInput'].includes(
    beforeClose.status,
  );
  assert.equal(
    report.activeWhenBrowserClosed,
    true,
    'Task completed too early to verify active-task browser closure.',
  );
  checks.push(
    'production-built UI served by real gateway',
    'real thread and turn submitted through browser HTTP controls',
  );

  // Close the entire Chromium process. The real gateway and its app-server continue independently.
  await browser.close();
  browser = undefined;
  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  assert.equal(codex.pid, initialPid);
  checks.push(
    'all browser pages and contexts closed while the turn was active',
    'app-server PID unchanged with no browser connected',
  );
  browser = await chromium.launch();
  page = await browser.newPage();
  let historyRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/threads?')) historyRequests++;
  });
  await page.goto(config.publicOrigin);
  await expect
    .poll(
      async () => {
        const count = await page.locator('.thread-link').count();
        if (count > 0) return count;
        if (pendingHumanAction)
          throw new Error('A human decision is required; no request is auto-approved.');
        const more = page.getByRole('button', { name: '加载更多会话', exact: true });
        if (await more.isVisible()) await more.click();
        else await page.getByRole('button', { name: '刷新会话列表', exact: true }).click();
        return page.locator('.thread-link').count();
      },
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(1);
  report.historyRequestsBeforeDiscovery = historyRequests;
  await page.locator('.thread-link').click();
  await expect(page.locator('.user-message')).toContainText('isolated real-browser smoke test');
  checks.push(
    'fresh browser without local storage discovered the same history and restored its snapshot',
  );

  const deadline = Date.now() + 180_000;
  let completed = false;
  while (Date.now() < deadline) {
    if (pendingHumanAction)
      throw new Error(
        'A real human approval/input request blocked verification. No request was auto-approved.',
      );
    assert.equal(codex.ready, true, 'The real app-server became unavailable.');
    const state = await runtime.service.getThread(threadId);
    const turn = state.turns.find((entry) => entry.id === currentTurnId);
    if (turn?.status === 'completed') {
      completed = true;
      break;
    }
    if (turn?.status === 'failed' || turn?.status === 'interrupted')
      throw new Error(`Real turn ended ${turn.status}: ${turn.error ?? ''}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  assert.equal(completed, true, 'Real-browser inference exceeded 180 seconds.');
  await expect(page.locator('.turn-heading .status')).toHaveText('已完成', { timeout: 10_000 });
  await expect(
    page.locator('.assistant-message').filter({ hasText: 'BROWSER_SMOKE_COMPLETE' }),
  ).toBeVisible();
  assert.equal(
    await readFile(join(project, 'smoke-browser.txt'), 'utf8'),
    'Codex browser smoke test\n',
  );
  const restored = await runtime.service.getThread(threadId);
  const turn = restored.turns.find((entry) => entry.id === currentTurnId)!;
  report.fileChangeObserved =
    turn.items.some((entry) =>
      entry.changes?.some((change) => change.path.endsWith('smoke-browser.txt')),
    ) || Boolean(turn.diff?.includes('smoke-browser.txt'));
  assert.equal(
    report.fileChangeObserved,
    true,
    'Expected real file change metadata in restored history.',
  );
  assert.equal(codex.pid, initialPid);
  report.pidUnchanged = true;
  report.manualRequestsAutoApproved = false;
  checks.push(
    'real assistant output and completed status visible after reopening',
    'exact requested temporary file content verified',
    'real file change/diff metadata restored',
    'same app-server PID throughout browser closure and recovery',
  );
  report.outcome = 'passed';
} catch (error) {
  failed = true;
  report.outcome = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  if (threadId && currentTurnId && codex.ready)
    await codex.interruptTurn(threadId, currentTurnId).catch(() => {});
} finally {
  unsubscribe();
  await browser?.close();
  await runtime?.close();
  await rm(root, { recursive: true, force: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (failed) process.exitCode = 1;
