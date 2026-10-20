import { t } from '../i18n';
import type {
  ModelDefaults,
  ModelInfo,
  PermissionMode,
  RuntimeSettings,
  Settings,
} from '../../shared/types';
import { permissionModes } from './permissions';

export function reportedPermissionMode(current?: RuntimeSettings) {
  if (current?.permissionMode) return current.permissionMode;
  if (current?.sandbox === 'external-sandbox' || current?.approvalPolicy === 'granular')
    return 'custom';
  return undefined;
}

export function permissionLabel(
  current: RuntimeSettings | undefined,
  unknown = t('common:not_reported'),
): string {
  const mode = reportedPermissionMode(current);
  if (mode === 'custom')
    return current?.permissionProfile
      ? t('settings:custom', { v0: current.permissionProfile.id })
      : t('settings:custom_2');
  if (mode) return permissionModes[mode].label;
  return current?.sandbox || current?.permissionProfile
    ? t('settings:cannot_determine_mode')
    : unknown;
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

export function selectedModelDefaults(
  settings: Settings,
  current: RuntimeSettings | undefined,
  model: ModelInfo,
): ModelDefaults {
  const effort = settings.reasoningEffort ?? current?.reasoningEffort;
  return {
    model: model.id,
    reasoningEffort:
      effort && model.reasoningEfforts.includes(effort)
        ? effort
        : model.reasoningEfforts.includes(model.defaultReasoningEffort ?? '')
          ? (model.defaultReasoningEffort ?? null)
          : (model.reasoningEfforts[0] ?? null),
  };
}

export function chooseModel(
  settings: Settings,
  current: RuntimeSettings | undefined,
  model: ModelInfo,
): Settings {
  const selected = selectedModelDefaults(settings, current, model);
  const next: Settings = { ...settings, model: selected.model };
  if (selected.reasoningEffort === null) delete next.reasoningEffort;
  else next.reasoningEffort = selected.reasoningEffort;
  const tier = settings.serviceTier !== undefined ? settings.serviceTier : current?.serviceTier;
  if (tier === 'fast' && !model.serviceTiers?.includes('fast')) next.serviceTier = null;
  return pendingSettings(next, current);
}

export function speedLabel(
  tier: string | null | undefined,
  unknown = t('common:not_reported'),
): string {
  if (tier === null || tier === 'default') return t('settings:fast_off');
  if (tier === 'fast') return t('settings:fast_on');
  return tier === undefined ? `Fast ${unknown}` : tier;
}
