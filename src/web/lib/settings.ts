import type { ModelInfo, RuntimeSettings, Settings } from '../../shared/types';

/** Keep only user edits that have not yet been reported by the server. */
export function pendingSettings(settings: Settings, current?: RuntimeSettings): Settings {
  return Object.fromEntries(
    Object.entries(settings).filter(
      ([key, value]) =>
        value !== undefined &&
        (value !== current?.[key as keyof Settings] ||
          (key === 'reasoningEffort' &&
            settings.model !== undefined &&
            settings.model !== current?.model)),
    ),
  );
}

export function chooseModel(
  settings: Settings,
  current: RuntimeSettings | undefined,
  model: ModelInfo,
): Settings {
  const next: Settings = { ...settings, model: model.id };
  const effort = settings.reasoningEffort ?? current?.reasoningEffort;
  if (effort && model.reasoningEfforts.includes(effort)) next.reasoningEffort = effort;
  else {
    // This is an explicit proposed choice, not an assertion about the running session.
    next.reasoningEffort = model.reasoningEfforts.includes(model.defaultReasoningEffort ?? '')
      ? model.defaultReasoningEffort
      : model.reasoningEfforts[0];
    if (!next.reasoningEffort) delete next.reasoningEffort;
  }
  return pendingSettings(next, current);
}
