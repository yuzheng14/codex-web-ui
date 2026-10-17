import type { ModelInfo, PermissionMode, RuntimeSettings, Settings } from '../../shared/types';
import { permissionModes } from '../../shared/permissions';

export function reportedPermissionMode(current?: RuntimeSettings) {
  if (current?.permissionMode) return current.permissionMode;
  if (current?.sandbox === 'external-sandbox' || current?.approvalPolicy === 'granular')
    return 'custom';
  return undefined;
}

export function permissionLabel(current: RuntimeSettings | undefined, unknown = '未报告'): string {
  const mode = reportedPermissionMode(current);
  if (mode === 'custom')
    return current?.permissionProfile ? `自定义 · ${current.permissionProfile.id}` : '自定义';
  if (mode) return permissionModes[mode].label;
  return current?.sandbox || current?.permissionProfile ? '无法判断模式' : unknown;
}

export function choosePermissionMode(
  settings: Settings,
  current: RuntimeSettings | undefined,
  mode: PermissionMode,
): Settings {
  const next = { ...settings, permissionMode: mode };
  delete next.sandbox;
  delete next.approvalPolicy;
  delete next.approvalReviewer;
  return pendingSettings(next, current);
}

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
