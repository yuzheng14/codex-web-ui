import { expect, it } from 'vitest';
import {
  chooseModel,
  choosePermissionMode,
  pendingSettings,
  permissionLabel,
  selectedModelDefaults,
} from '../../src/web/lib/settings';
import type { ModelInfo } from '../../src/shared/types';
const model: ModelInfo = {
  id: 'model-b',
  name: 'B',
  description: '',
  reasoningEfforts: ['low', 'high'],
  defaultReasoningEffort: 'high',
};
it('saves a complete supported pair even when a field already matches the current session', () => {
  const current = { model: 'model-b', reasoningEffort: 'high' };
  expect(chooseModel({}, current, model)).toEqual({});
  expect(selectedModelDefaults({}, current, model)).toEqual(current);
  expect(selectedModelDefaults({ reasoningEffort: 'low' }, current, model)).toEqual({
    model: 'model-b',
    reasoningEffort: 'low',
  });
  expect(selectedModelDefaults({}, current, { ...model, reasoningEfforts: [] })).toEqual({
    model: 'model-b',
    reasoningEffort: null,
  });
});
it('proposes a supported effort on model switch without claiming it is already active', () => {
  const current = { model: 'model-a', reasoningEffort: 'medium' };
  expect(chooseModel({}, current, model)).toEqual({ model: 'model-b', reasoningEffort: 'high' });
  expect(current).toEqual({ model: 'model-a', reasoningEffort: 'medium' });
  expect(chooseModel({}, { ...current, reasoningEffort: 'low' }, model)).toEqual({
    model: 'model-b',
    reasoningEffort: 'low',
  });
});
it('keeps an entire mode pending until the complete reported mode matches', () => {
  const current = {
    model: 'model-a',
    reasoningEffort: 'high',
    sandbox: 'workspace-write' as const,
    approvalPolicy: 'on-request' as const,
    approvalReviewer: 'auto_review',
    permissionMode: 'custom' as const,
  };
  expect(pendingSettings({ permissionMode: 'auto-review' }, current)).toEqual({
    permissionMode: 'auto-review',
  });
  expect(
    pendingSettings(
      { permissionMode: 'auto-review' },
      { ...current, permissionMode: 'auto-review' },
    ),
  ).toEqual({});
  expect(
    choosePermissionMode(
      {
        model: 'model-b',
        sandbox: 'read-only',
        approvalPolicy: 'never',
        approvalReviewer: 'auto_review',
      },
      current,
      'ask',
    ),
  ).toEqual({ model: 'model-b', permissionMode: 'ask' });
  expect(chooseModel({ permissionMode: 'auto-review' }, current, model).permissionMode).toBe(
    'auto-review',
  );
});
it('uses explicit unknown and custom labels without guessing a preset from a legacy pair', () => {
  expect(permissionLabel(undefined, '读取中…')).toBe('读取中…');
  expect(permissionLabel({ model: null, reasoningEffort: null })).toBe('未报告');
  expect(
    permissionLabel({
      model: null,
      reasoningEffort: null,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    }),
  ).toBe('无法判断模式');
  expect(
    permissionLabel({
      model: null,
      reasoningEffort: null,
      permissionMode: 'custom',
      permissionProfile: { id: 'company', extends: ':workspace' },
    }),
  ).toBe('自定义 · company');
});
it('drops acknowledged edits but keeps newer edits and never sends observed custom policies', () => {
  expect(
    pendingSettings(
      { reasoningEffort: 'high', sandbox: 'read-only' },
      {
        model: 'model-a',
        reasoningEffort: 'low',
        sandbox: 'read-only',
        approvalPolicy: 'granular',
      },
    ),
  ).toEqual({ reasoningEffort: 'high' });
  expect(
    pendingSettings(
      { model: 'model-b', reasoningEffort: 'high' },
      { model: 'model-b', reasoningEffort: 'high' },
    ),
  ).toEqual({});
});

it('keeps explicit Fast-off pending until confirmed and clears Fast on an unsupported model', () => {
  const current = { model: 'model-a', reasoningEffort: 'high', serviceTier: 'fast' };
  expect(pendingSettings({ serviceTier: null }, current)).toEqual({ serviceTier: null });
  expect(pendingSettings({ serviceTier: null }, { ...current, serviceTier: null })).toEqual({});
  expect(pendingSettings({ serviceTier: null }, { model: null, reasoningEffort: null })).toEqual({
    serviceTier: null,
  });
  expect(chooseModel({}, current, model).serviceTier).toBeNull();
  expect(
    chooseModel(
      { serviceTier: 'fast' },
      { ...current, serviceTier: null },
      { ...model, serviceTiers: ['fast'] },
    ).serviceTier,
  ).toBe('fast');
});
