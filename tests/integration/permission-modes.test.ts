import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexAdapter, type AdapterEvent } from '../../src/codex/adapter.js';
import { permissionSettings, threadSettings, turnSettings } from '../../src/codex/mapping.js';
import { permissionModes, permissionModeUnavailable } from '../../src/shared/permissions.js';
import { settingsSchema } from '../../src/shared/validation.js';
import type { PermissionMode } from '../../src/shared/types.js';
import type { SimulatorOptions } from '../fixtures/app-server.js';

const resources: { adapter: CodexAdapter; dir: string }[] = [];
afterEach(async () => {
  for (const { adapter, dir } of resources.splice(0)) {
    await adapter.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
async function fixture(options: SimulatorOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-permission-test-'));
  const logPath = join(dir, 'rpc.jsonl');
  const adapter = new CodexAdapter({
    binary: resolve('tests/fixtures/codex.mjs'),
    args: ['--options', JSON.stringify({ turnDelayMs: 10, ...options, logPath })],
  });
  resources.push({ adapter, dir });
  const events: AdapterEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.start();
  return {
    adapter,
    dir,
    events,
    requests: async () =>
      (await readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> }),
  };
}
const modes = Object.keys(permissionModes) as PermissionMode[];

it.each(modes)(
  'validates and maps the complete %s selection without mixing legacy overrides',
  (mode) => {
    const preset = permissionModes[mode];
    expect(settingsSchema.parse({ permissionMode: mode })).toEqual({ permissionMode: mode });
    expect(
      settingsSchema.safeParse({ permissionMode: mode, approvalReviewer: 'user' }).success,
    ).toBe(false);
    expect(settingsSchema.safeParse({ permissionMode: mode, sandbox: 'read-only' }).success).toBe(
      false,
    );
    const expected = {
      permissions: preset.profile,
      approvalPolicy: preset.approvalPolicy,
      approvalsReviewer: preset.approvalReviewer,
    };
    expect(threadSettings({ permissionMode: mode })).toEqual(expected);
    expect(turnSettings('/project', { permissionMode: mode })).toEqual(expected);
    expect(threadSettings({ model: 'custom' })).toEqual({ model: 'custom' });
    expect(turnSettings('/project', { reasoningEffort: 'high' })).toEqual({ effort: 'high' });
  },
);

it('recognizes actual profiles and refuses to normalize custom or incomplete boundaries', () => {
  const sandbox = {
    type: 'workspaceWrite' as const,
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
  const profile = { id: ':workspace', extends: null };
  expect(
    permissionSettings(sandbox, 'on-request', 'user', profile, '/project').permissionMode,
  ).toBe('ask');
  expect(
    permissionSettings(sandbox, 'on-request', 'auto_review', profile, '/project').permissionMode,
  ).toBe('auto-review');
  expect(permissionSettings(sandbox, 'on-request', 'user').permissionMode).toBeNull();
  for (const custom of [
    { ...sandbox, networkAccess: true },
    { ...sandbox, writableRoots: ['/other'] },
    { ...sandbox, excludeSlashTmp: true },
    { ...sandbox, excludeTmpdirEnvVar: true },
  ])
    expect(
      permissionSettings(custom, 'on-request', 'user', profile, '/project').permissionMode,
    ).toBe('custom');
  expect(
    permissionSettings(sandbox, 'on-request', 'user', { id: 'company', extends: ':workspace' })
      .permissionMode,
  ).toBe('custom');
  expect(permissionSettings(sandbox, 'never', 'user', profile).permissionMode).toBe('custom');
});

it('sends complete selections through create, turn, resume and fork, and reports only observed confirmations', async () => {
  const { adapter, dir, events, requests } = await fixture();
  const thread = await adapter.createThread(dir, { permissionMode: 'auto-review' });
  expect(thread.runtimeSettings).toMatchObject({
    permissionMode: 'auto-review',
    approvalReviewer: 'auto_review',
    approvalPolicy: 'on-request',
    networkAccess: false,
    sandbox: 'workspace-write',
    permissionProfile: { id: ':workspace' },
  });
  expect(
    (await adapter.forkThread(thread.id, dir, { model: 'simulated-model' })).runtimeSettings
      ?.permissionMode,
  ).toBe('auto-review');
  for (const mode of ['ask', 'auto-review', 'full-access', 'read-only'] as const) {
    const turn = await adapter.startTurn(thread.id, dir, 'fixture permission switch', {
      permissionMode: mode,
    });
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === 'turn' && event.turn.id === turn.id && event.turn.status === 'completed',
        ),
      )
      .toBe(true);
    expect(events.filter((event) => event.type === 'threadSettings').at(-1)).toMatchObject({
      settings: { permissionMode: mode, approvalReviewer: permissionModes[mode].approvalReviewer },
    });
  }
  expect((await adapter.resumeThread(thread.id, dir)).runtimeSettings?.permissionMode).toBe(
    'read-only',
  );
  expect(
    (await adapter.forkThread(thread.id, dir, { permissionMode: 'auto-review' })).runtimeSettings
      ?.permissionMode,
  ).toBe('auto-review');
  const calls = await requests();
  for (const request of calls.filter(
    (entry) => entry.method === 'turn/start' && entry.params.threadId === thread.id,
  )) {
    expect(request.params).toHaveProperty('permissions');
    expect(request.params).toHaveProperty('approvalsReviewer');
    expect(request.params).not.toHaveProperty('sandboxPolicy');
  }
  expect(calls.find((entry) => entry.method === 'thread/resume')?.params).not.toHaveProperty(
    'permissions',
  );
});

it('keeps inherited custom profiles untouched when only the model changes', async () => {
  const { adapter, dir, events, requests } = await fixture({
    activePermissionProfile: 'company',
    configOverrides: { default_permissions: 'company' },
  });
  expect(await adapter.readRuntimeSettings(dir)).toMatchObject({
    permissionMode: 'custom',
    permissionProfile: { id: 'company' },
  });
  const thread = await adapter.createThread(dir, { model: 'simulated-model' });
  expect(thread.runtimeSettings?.permissionMode).toBe('custom');
  await adapter.startTurn(thread.id, dir, 'fixture', { reasoningEffort: 'high' });
  await expect.poll(() => events.some((event) => event.type === 'threadSettings')).toBe(true);
  for (const { params } of (await requests()).filter(
    (entry) =>
      (entry.method === 'thread/start' && !entry.params.ephemeral) ||
      (entry.method === 'turn/start' && entry.params.threadId === thread.id),
  )) {
    expect(params).not.toHaveProperty('permissions');
    expect(params).not.toHaveProperty('approvalsReviewer');
    expect(params).not.toHaveProperty('approvalPolicy');
    expect(params).not.toHaveProperty('sandboxPolicy');
  }
});

it('blocks unavailable auto review and managed full access before dispatching a mutation', async () => {
  const { adapter, dir, requests } = await fixture({
    guardianApproval: false,
    requirements: { allowedPermissionProfiles: { ':workspace': true, ':read-only': true } },
  });
  const capabilities = (await adapter.readRuntimeSettings(dir)).permissionCapabilities;
  expect(permissionModeUnavailable('auto-review', capabilities)).toContain('未启用自动审核');
  expect(permissionModeUnavailable('full-access', capabilities)).toContain('受管要求');
  for (const mode of ['auto-review', 'full-access'] as const)
    await expect(adapter.createThread(dir, { permissionMode: mode })).rejects.toMatchObject({
      code: 'PERMISSION_MODE_UNAVAILABLE',
    });
  expect((await requests()).filter((entry) => entry.method === 'thread/start')).toHaveLength(0);
});

it('propagates upstream rejection without publishing the requested mode as effective', async () => {
  const { adapter, dir, events } = await fixture({ rejectPermissions: true });
  const thread = await adapter.createThread(dir);
  await expect(
    adapter.startTurn(thread.id, dir, 'fixture', { permissionMode: 'auto-review' }),
  ).rejects.toThrow('Managed policy rejected');
  expect(events.filter((event) => event.type === 'threadSettings')).toHaveLength(0);
  expect((await adapter.resumeThread(thread.id, dir)).runtimeSettings?.permissionMode).toBe(
    'read-only',
  );
});

it('leaves permissions inherited when capability discovery is unavailable', async () => {
  const { adapter, dir, requests } = await fixture({
    unsupportedMethod: 'configRequirements/read',
  });
  const current = await adapter.readRuntimeSettings(dir);
  expect(current.permissionCapabilities?.unavailableReason).toContain('无法核实');
  await expect(adapter.createThread(dir, { permissionMode: 'auto-review' })).rejects.toMatchObject({
    code: 'PERMISSION_MODE_UNAVAILABLE',
  });
  expect((await adapter.createThread(dir)).runtimeSettings?.permissionMode).toBe('read-only');
  expect(
    (await requests()).find((entry) => entry.method === 'thread/start')?.params,
  ).not.toHaveProperty('permissions');
});

it('enforces managed reviewer and model constraints for an explicit new-session choice', async () => {
  const { adapter, dir } = await fixture({
    requirements: {
      autoReview: { requiredOnModels: ['simulated-model'], ignoreRules: null },
      allowedApprovalsReviewers: ['auto_review'],
    },
  });
  await expect(adapter.createThread(dir, { permissionMode: 'ask' })).rejects.toMatchObject({
    code: 'PERMISSION_MODE_UNAVAILABLE',
  });
  expect(
    (await adapter.createThread(dir, { permissionMode: 'auto-review' })).runtimeSettings
      ?.permissionMode,
  ).toBe('auto-review');
});

it('retains capability discovery when a newer settings notification wins over the lifecycle result', async () => {
  const { adapter, dir, events } = await fixture({ settingsOnFeatureRead: true });
  const created = await adapter.createThread(dir, { permissionMode: 'auto-review' });
  const latest = events
    .filter((event) => event.type === 'threadSettings' && event.threadId === created.id)
    .at(-1);
  expect(latest).toMatchObject({
    settings: { permissionMode: 'auto-review', permissionCapabilities: { autoReview: true } },
  });
});

it('never enables automatic review from a project override when managed feature requirements prohibit it', async () => {
  const { adapter, dir, requests } = await fixture({
    configOverrides: { features: { guardian_approval: true } },
    requirements: { featureRequirements: { guardian_approval: false } },
  });
  expect((await adapter.readRuntimeSettings(dir)).permissionCapabilities?.autoReview).toBe(false);
  await expect(adapter.createThread(dir, { permissionMode: 'auto-review' })).rejects.toMatchObject({
    code: 'PERMISSION_MODE_UNAVAILABLE',
  });
  expect((await requests()).some((request) => request.method === 'thread/start')).toBe(false);
});
