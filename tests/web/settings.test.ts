import { expect, it } from 'vitest';
import { chooseModel, pendingSettings } from '../../src/web/lib/settings';
import type { ModelInfo } from '../../src/shared/types';
const model: ModelInfo = {
  id: 'model-b',
  name: 'B',
  description: '',
  reasoningEfforts: ['low', 'high'],
  defaultReasoningEffort: 'high',
};
it('proposes a supported effort on model switch without claiming it is already active', () => {
  const current = { model: 'model-a', reasoningEffort: 'medium' };
  expect(chooseModel({}, current, model)).toEqual({ model: 'model-b', reasoningEffort: 'high' });
  expect(current).toEqual({ model: 'model-a', reasoningEffort: 'medium' });
  expect(chooseModel({}, { ...current, reasoningEffort: 'low' }, model)).toEqual({
    model: 'model-b',
    reasoningEffort: 'low',
  });
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
