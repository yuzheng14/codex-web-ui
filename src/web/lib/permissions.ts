import { resources } from '../i18n/resources';
import { t } from '../i18n';
import {
  permissionModes as presets,
  permissionModeUnavailable as unavailable,
} from '../../shared/permissions';
import type { PermissionMode } from '../../shared/types';

export const permissionModes = Object.fromEntries(
  (Object.keys(presets) as PermissionMode[]).map((mode) => [
    mode,
    {
      ...presets[mode],
      get label() {
        return t(`settings:permission_${mode}`);
      },
      get description() {
        return t(`settings:permission_${mode}_description`);
      },
    },
  ]),
) as Record<
  PermissionMode,
  Omit<(typeof presets)[PermissionMode], 'label' | 'description'> & {
    label: string;
    description: string;
  }
>;

export function permissionModeUnavailable(...args: Parameters<typeof unavailable>) {
  const reason = unavailable(...args);
  if (!reason) return undefined;
  const keys = [
    'missingCapabilities',
    'profileRestricted',
    'scopeRestricted',
    'policyRestricted',
    'reviewerMissing',
    'reviewerRestricted',
    'autoReviewDisabled',
    'autoReviewRequired',
  ] as const;
  const key = keys.find((key) => resources['zh-Hans'].settings[key] === reason);
  return t(key ? `settings:${key}` : 'settings:permission_unavailable');
}
