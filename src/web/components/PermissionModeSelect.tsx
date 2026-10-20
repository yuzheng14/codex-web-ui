import { t, formatList } from '../i18n';
import { useEffect, useState } from 'react';
import { permissionModes, permissionModeUnavailable } from '../lib/permissions';
import type { PermissionMode, RuntimeSettings, Settings } from '../../shared/types';
import { choosePermissionMode, permissionLabel, reportedPermissionMode } from '../lib/settings';
import { Icon } from './Icon';
import { ControlHint } from './ControlHint';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export function PermissionModeSelect({
  settings,
  current,
  unknown,
  disabled,
  scope,
  onChange,
}: {
  settings: Settings;
  current?: RuntimeSettings;
  unknown: string;
  disabled: boolean;
  scope?: string;
  onChange: (settings: Settings) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [scope, disabled]);
  const value = settings.permissionMode ?? reportedPermissionMode(current) ?? '';
  const label = settings.permissionMode
    ? permissionModes[settings.permissionMode].label
    : permissionLabel(current, unknown);
  return (
    <Select
      value={value}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(value) => {
        const mode = value as PermissionMode;
        if (
          mode in permissionModes &&
          !permissionModeUnavailable(
            mode,
            current?.permissionCapabilities,
            settings.model ?? current?.model,
          )
        )
          onChange(choosePermissionMode(settings, current, mode));
      }}
    >
      <ControlHint
        content={t('settings:permission_mode', {
          v0: label,
          v1: settings.permissionMode ? t('settings:pending') : '',
        })}
        suppressed={open}
      >
        <SelectTrigger
          className="settings-policy"
          aria-label={t('settings:permission_mode_2')}
          data-value={value}
        >
          <Icon name="shield" size={16} />
          <span className="permission-mode-label">
            <SelectValue placeholder={unknown}>{label}</SelectValue>
          </span>
          {settings.permissionMode && (
            <span className="permission-pending-dot" aria-label={t('settings:pending_2')} />
          )}
        </SelectTrigger>
      </ControlHint>
      <SelectContent
        className="permission-mode-menu"
        side="top"
        align="start"
        aria-label={t('settings:permission_mode_2')}
      >
        {value === 'custom' && (
          <SelectItem value="custom" disabled>
            {t('settings:keep_current_settings', { v0: label })}
          </SelectItem>
        )}
        {(Object.keys(permissionModes) as PermissionMode[]).map((mode) => {
          const preset = permissionModes[mode];
          const reason = permissionModeUnavailable(
            mode,
            current?.permissionCapabilities,
            settings.model ?? current?.model,
          );
          return (
            <SelectItem
              key={mode}
              value={mode}
              textValue={preset.label}
              disabled={Boolean(reason)}
              description={
                <span className="permission-description">
                  <span>{preset.description}</span>
                  {reason && <span className="permission-unavailable">{reason}</span>}
                </span>
              }
            >
              <strong>{preset.label}</strong>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

const sandboxLabels: Record<string, string> = {
  get 'read-only'() {
    return t('common:read_only');
  },
  get 'workspace-write'() {
    return t('settings:write_within_project');
  },
  get 'danger-full-access'() {
    return t('settings:full_access');
  },
  get 'external-sandbox'() {
    return t('settings:external_sandbox');
  },
};
const approvalLabels: Record<string, string> = {
  get untrusted() {
    return t('settings:approval_for_untrusted_operations');
  },
  get 'on-request'() {
    return t('settings:approval_requested_by_codex');
  },
  get never() {
    return t('settings:never_request_approval');
  },
  get granular() {
    return t('settings:custom_approval_rules');
  },
};

export function PermissionDetails({
  current,
  source,
  settings,
  thread,
  unknown,
}: {
  current?: RuntimeSettings;
  source: string;
  settings: Settings;
  thread: boolean;
  unknown: string;
}) {
  const pending = settings.permissionMode;
  const reason =
    pending &&
    permissionModeUnavailable(
      pending,
      current?.permissionCapabilities,
      settings.model ?? current?.model,
    );
  return (
    <>
      <div className="settings-heading">
        <strong>{t('common:permission_details')}</strong>
        <span>{source}</span>
      </div>
      <p className="settings-note">
        {t('settings:current_mode', {
          v0: permissionLabel(current, unknown),
          v1: pending && t('settings:pending_3', { v0: permissionModes[pending].label }),
        })}
      </p>
      <dl className="permission-values">
        <div>
          <dt>{t('settings:permission_scope')}</dt>
          <dd>{sandboxLabels[current?.sandbox ?? ''] ?? unknown}</dd>
        </div>
        <div>
          <dt>{t('settings:approval_policy')}</dt>
          <dd>{approvalLabels[current?.approvalPolicy ?? ''] ?? unknown}</dd>
        </div>
        <div>
          <dt>{t('settings:permission_profile')}</dt>
          <dd>
            {current?.permissionProfile?.id ?? t('common:not_reported')}
            {current?.permissionProfile?.extends &&
              t('settings:inherited', { v0: current.permissionProfile.extends })}
          </dd>
        </div>
        <div>
          <dt>{t('settings:writable_directories')}</dt>
          <dd>
            {current?.sandbox === 'danger-full-access'
              ? t('settings:no_codex_sandbox_restrictions')
              : current?.sandbox === 'read-only'
                ? t('settings:writing_requires_additional_approval')
                : current?.writableRoots
                  ? formatList([t('settings:project_directory'), ...current.writableRoots])
                  : t('common:not_reported')}
          </dd>
        </div>
        {current?.sandbox === 'workspace-write' && (
          <div>
            <dt>{t('settings:temporary_directory')}</dt>
            <dd>
              {t('settings:temporaryDirectories', {
                tmpdir:
                  current.excludeTmpdirEnvVar == null
                    ? t('common:not_reported')
                    : current.excludeTmpdirEnvVar
                      ? t('settings:excluded')
                      : t('settings:allowed'),
                slashTmp:
                  current.excludeSlashTmp == null
                    ? t('common:not_reported')
                    : current.excludeSlashTmp
                      ? t('settings:excluded')
                      : t('settings:allowed'),
              })}
            </dd>
          </div>
        )}
      </dl>
      <p className="settings-observed">
        {t('settings:current_network_permission', {
          v0:
            current?.networkAccess == null
              ? t('common:not_reported')
              : current.networkAccess
                ? t('settings:allowed')
                : t('settings:restricted'),
        })}
        <span>
          {t('settings:approval_reviewer', {
            v0: current?.approvalReviewer ?? t('common:not_reported'),
          })}
        </span>
      </p>
      <p className="settings-note">
        {t('settings:changes_apply_only_to_this_via_subject_to', {
          v0: thread
            ? t('settings:session_s_subsequent_operations')
            : t('settings:project_s_new_sessions'),
          v1: thread ? t('settings:starting_the_next_task') : t('settings:creating_a_new_session'),
        })}
      </p>
      {(!current?.permissionMode || current.permissionMode === 'custom') && (
        <p className="settings-note">
          {t('settings:keep_actual_settings_permissions_are_unchanged_until_another')}
        </p>
      )}
      {reason && (
        <p className="settings-error" role="status">
          {t('settings:pending_selection_is_currently_unavailable', { v0: reason })}
        </p>
      )}
    </>
  );
}
