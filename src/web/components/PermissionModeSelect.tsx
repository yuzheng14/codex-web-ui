import { useEffect, useState } from 'react';
import { permissionModes, permissionModeUnavailable } from '../../shared/permissions';
import type { PermissionMode, RuntimeSettings, Settings } from '../../shared/types';
import { choosePermissionMode, permissionLabel, reportedPermissionMode } from '../lib/settings';
import { Icon } from './Icon';
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
      <SelectTrigger
        className="settings-policy"
        aria-label="权限模式"
        title={`权限模式：${label}${settings.permissionMode ? '（待生效）' : ''}`}
        data-value={value}
      >
        <Icon name="shield" size={16} />
        <span className="permission-mode-label">
          <SelectValue placeholder={unknown}>{label}</SelectValue>
        </span>
        {settings.permissionMode && <span className="permission-pending-dot" aria-label="待生效" />}
      </SelectTrigger>
      <SelectContent
        className="permission-mode-menu"
        side="top"
        align="start"
        aria-label="权限模式"
      >
        {value === 'custom' && (
          <SelectItem value="custom" disabled>
            {label}（保留当前配置）
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
  'read-only': '只读',
  'workspace-write': '项目内写入',
  'danger-full-access': '完全访问',
  'external-sandbox': '外部沙箱',
};
const approvalLabels: Record<string, string> = {
  untrusted: '不可信操作需审批',
  'on-request': '由 Codex 请求审批',
  never: '不请求审批',
  granular: '自定义审批规则',
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
        <strong>权限详情</strong>
        <span>{source}</span>
      </div>
      <p className="settings-note">
        当前模式：{permissionLabel(current, unknown)}
        {pending && `；待生效：${permissionModes[pending].label}`}
      </p>
      <dl className="permission-values">
        <div>
          <dt>权限范围</dt>
          <dd>{sandboxLabels[current?.sandbox ?? ''] ?? unknown}</dd>
        </div>
        <div>
          <dt>审批策略</dt>
          <dd>{approvalLabels[current?.approvalPolicy ?? ''] ?? unknown}</dd>
        </div>
        <div>
          <dt>权限 profile</dt>
          <dd>
            {current?.permissionProfile?.id ?? '未报告'}
            {current?.permissionProfile?.extends && `（继承 ${current.permissionProfile.extends}）`}
          </dd>
        </div>
        <div>
          <dt>可写目录</dt>
          <dd>
            {current?.sandbox === 'danger-full-access'
              ? '无 Codex 沙箱限制'
              : current?.sandbox === 'read-only'
                ? '写入需额外批准'
                : current?.writableRoots
                  ? ['项目目录', ...current.writableRoots].join('、')
                  : '未报告'}
          </dd>
        </div>
        {current?.sandbox === 'workspace-write' && (
          <div>
            <dt>临时目录</dt>
            <dd>
              TMPDIR：
              {current.excludeTmpdirEnvVar == null
                ? '未报告'
                : current.excludeTmpdirEnvVar
                  ? '排除'
                  : '允许'}
              ；/tmp：
              {current.excludeSlashTmp == null
                ? '未报告'
                : current.excludeSlashTmp
                  ? '排除'
                  : '允许'}
            </dd>
          </div>
        )}
      </dl>
      <p className="settings-observed">
        当前网络权限：
        {current?.networkAccess == null ? '未报告' : current.networkAccess ? '允许' : '受限'}
        <span>审批执行方：{current?.approvalReviewer ?? '未报告'}</span>
      </p>
      <p className="settings-note">
        修改仅用于此{thread ? '会话的后续操作' : '项目的新会话'}，
        {thread ? '下次任务开始时' : '新建会话时'}请求应用，以 Codex 确认为准，不更改全局配置。
      </p>
      {(!current?.permissionMode || current.permissionMode === 'custom') && (
        <p className="settings-note">保留实际配置；尚未选择其他模式时不会改写权限。</p>
      )}
      {reason && (
        <p className="settings-error" role="status">
          待生效选择目前不可用：{reason}
        </p>
      )}
    </>
  );
}
