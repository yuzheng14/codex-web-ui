/** Opt-in actual inference, cancellation and approval routing in a fresh temporary project. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter, type AdapterEvent } from '../src/codex/adapter.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const expectedIndex = args.indexOf('--expected-version');
const expectedVersion = expectedIndex >= 0 ? args[expectedIndex + 1] : undefined;
assert.match(
  expectedVersion ?? '',
  /^\d+\.\d+\.\d+$/,
  'Pass --expected-version with an exact CLI version',
);
if (!args.includes('--inference')) throw new Error('Pass --inference to use model quota');
const configIndex = args.indexOf('--config');
if (configIndex < 0) throw new Error('Pass --config selecting a binary and an isolated CODEX_HOME');
const { codex } = JSON.parse(await readFile(resolve(args[configIndex + 1]!), 'utf8')) as {
  codex: { binary: string; home: string };
};
if (!codex.home) throw new Error('An isolated CODEX_HOME is required');
const project = await mkdtemp(join(tmpdir(), 'codex-upgrade-interactions-'));
const adapter = new CodexAdapter(codex);
const events: AdapterEvent[] = [];
const checks: string[] = [];
const report: Record<string, unknown> = { inference: true, project, checks };
let threadId: string | undefined;
let turnId: string | undefined;
adapter.onEvent((event) => events.push(event));
async function waitFor<T>(get: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (!adapter.ready || Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
async function terminal(id: string) {
  const event = await waitFor(
    () =>
      events.find(
        (entry) =>
          entry.type === 'turn' &&
          entry.turn.id === id &&
          ['completed', 'interrupted', 'failed'].includes(entry.turn.status),
      ),
    'terminal turn event',
  );
  assert.equal(event.type, 'turn');
  if (event.type !== 'turn') throw new Error('Wrong event');
  return event.turn;
}
try {
  await adapter.start();
  report.codexVersion = adapter.diagnostics().codexVersion;
  assert.equal(report.codexVersion, expectedVersion);
  assert.equal(adapter.diagnostics().authenticated, true);
  const thread = await adapter.createThread(project, {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
  });
  threadId = thread.id;
  const first = await adapter.startTurn(
    thread.id,
    project,
    'This is an isolated cancellation test. Immediately run exactly one shell command: printf "UPGRADE_WAITING\\n"; sleep 20. Use exec_command with yield_time_ms=30000 so the tool remains active. Do not read or write files, do not access network, and do not call other tools. After it finishes, reply DONE. The client will interrupt it.',
  );
  turnId = first.id;
  await waitFor(
    () =>
      events.find(
        (event) =>
          event.type === 'item' &&
          event.turnId === first.id &&
          event.item.type === 'commandExecution' &&
          event.item.command?.includes('sleep 20'),
      ),
    'nested shell tool start',
  );
  const steer = await adapter.steerTurn(
    thread.id,
    first.id,
    'After the current command, reply STEER_RECEIVED.',
  );
  assert.equal(steer.turnId, first.id);
  checks.push('actual steer accepted with expectedTurnId while a nested shell tool is active');
  await adapter.interruptTurn(thread.id, first.id);
  assert.equal((await terminal(first.id)).status, 'interrupted');
  checks.push('Code Mode/nested shell interruption confirmed by turn/completed');
  await assert.rejects(adapter.steerTurn(thread.id, first.id, 'must remain a draft'));
  checks.push('steer of ended turn rejected without replay');
  const next = await adapter.startTurn(
    thread.id,
    project,
    'Reply exactly UPGRADE_NEXT_TURN. Do not call tools.',
  );
  turnId = next.id;
  assert.equal((await terminal(next.id)).status, 'completed');
  const after = await adapter.readThread(thread.id);
  assert(
    after.turns
      .find((turn) => turn.id === next.id)
      ?.items.some((item) => item.text?.includes('UPGRADE_NEXT_TURN')),
  );
  checks.push('next turn completes immediately after confirmed interruption');
  const approval = await adapter.startTurn(
    thread.id,
    project,
    'This is an approval-routing test. Call exec_command exactly once with cmd="pwd", sandbox_permissions="require_escalated", and justification="Isolated upgrade approval test: print working directory". Do not call any other tool, read files, change files, or use network. The client will decline approval. If declined, reply DENIED and stop.',
    { sandbox: 'read-only', approvalPolicy: 'on-request', approvalReviewer: 'user' },
  );
  turnId = approval.id;
  const action = await waitFor(
    () =>
      events.find(
        (event) =>
          event.type === 'action' &&
          event.action.turnId === approval.id &&
          event.action.kind === 'command' &&
          event.action.status === 'pending',
      ),
    'human command approval',
  );
  assert.equal(action.type, 'action');
  if (action.type !== 'action') throw new Error('Wrong event');
  await adapter.respond(action.action.actionId, { decision: 'decline' });
  await terminal(approval.id);
  await assert.rejects(adapter.respond(action.action.actionId, { decision: 'accept' }), {
    code: 'ACTION_EXPIRED',
  });
  checks.push('actual user-routed command approval declined; stale response rejected');
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (threadId && turnId && adapter.ready)
    await adapter.interruptTurn(threadId, turnId).catch(() => {});
  await adapter.stop();
  const output = JSON.stringify(report, null, 2) + '\n';
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0) await writeFile(resolve(args[outputIndex + 1]!), output);
  process.stdout.write(output);
}
