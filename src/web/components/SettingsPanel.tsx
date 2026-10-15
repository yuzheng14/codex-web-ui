import { useId, useState } from 'react';
import type { ModelInfo, Settings, ThreadView } from '../../shared/types';
import { useRuntimeDefaults } from '../hooks/useRuntimeDefaults';
import { chooseModel, pendingSettings } from '../lib/settings';
import { Icon } from './Icon';

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

export function SettingsPanel({
  settings,
  models,
  thread,
  projectId,
  runtimeKey,
  disabled,
  threadLoading,
  onChange,
}: {
  settings: Settings;
  models: ModelInfo[];
  thread?: ThreadView;
  projectId?: string;
  runtimeKey?: string;
  disabled: boolean;
  threadLoading?: boolean;
  onChange: (settings: Settings) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const advancedId = useId();
  const defaults = useRuntimeDefaults(thread || threadLoading ? undefined : projectId, runtimeKey);
  const current = thread ? thread.runtimeSettings : defaults.value;
  const unknown = threadLoading || (defaults.loading && !thread) ? '读取中…' : '未报告';
  const model = settings.model ?? current?.model ?? '';
  const effort = settings.reasoningEffort ?? current?.reasoningEffort ?? '';
  const sandbox = settings.sandbox ?? current?.sandbox ?? '';
  const approval = settings.approvalPolicy ?? current?.approvalPolicy ?? '';
  const selectedModel = models.find((entry) => entry.id === model);
  const pending = Object.keys(pendingSettings(settings, current)).length > 0;
  const source = thread ? (thread.managed ? '会话当前配置' : '会话保存配置') : '新会话默认配置';
  function update(key: keyof Settings, value: string) {
    onChange(pendingSettings({ ...settings, [key]: value }, current));
  }
  return (
    <div className="settings-panel" role="group" aria-label="运行设置">
      <div className="settings-toolbar">
        <label className="settings-choice settings-model">
          <span>模型</span>
          <select
            aria-label="模型"
            value={model}
            disabled={disabled || !models.length}
            onChange={(event) => {
              const selected = models.find((entry) => entry.id === event.target.value);
              if (selected) onChange(chooseModel(settings, current, selected));
            }}
          >
            {!selectedModel && (
              <option value={model} disabled>
                {model || unknown}
              </option>
            )}
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-choice settings-effort">
          <span>推理</span>
          <select
            aria-label="推理强度"
            value={effort}
            disabled={disabled || !selectedModel?.reasoningEfforts.length}
            onChange={(event) => update('reasoningEffort', event.target.value)}
          >
            {!selectedModel?.reasoningEfforts.includes(effort) && (
              <option value={effort} disabled>
                {effort || unknown}
              </option>
            )}
            {selectedModel?.reasoningEfforts.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <button
          className="settings-more"
          type="button"
          aria-expanded={expanded}
          aria-controls={advancedId}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name="settings" size={15} />
          <span>更多设置</span>
        </button>
      </div>
      {pending && (
        <div className="settings-pending" role="status">
          <span>
            {!thread
              ? '新建会话时生效'
              : thread.managed
                ? '下次任务生效'
                : '恢复后发送或 Fork 时生效'}{' '}
            · 当前 {current?.model ?? '未报告'} / {current?.reasoningEffort ?? '未报告'}
          </span>
          <button type="button" disabled={disabled} onClick={() => onChange({})}>
            撤销修改
          </button>
        </div>
      )}
      {!thread && defaults.error && (
        <p className="settings-error" role="status">
          {defaults.error}{' '}
          <button type="button" onClick={defaults.retry}>
            重试
          </button>
        </p>
      )}
      {expanded && (
        <div className="settings-fields" id={advancedId}>
          <div className="settings-heading">
            <strong>运行设置</strong>
            <span>{source}</span>
          </div>
          <label>
            权限范围
            <select
              value={sandbox}
              disabled={disabled}
              onChange={(event) => update('sandbox', event.target.value)}
            >
              {!sandbox && (
                <option value="" disabled>
                  {unknown}
                </option>
              )}
              {sandbox === 'external-sandbox' && (
                <option value={sandbox} disabled>
                  {sandboxLabels[sandbox]}
                </option>
              )}
              {['read-only', 'workspace-write', 'danger-full-access'].map((entry) => (
                <option key={entry} value={entry}>
                  {sandboxLabels[entry]}
                </option>
              ))}
            </select>
          </label>
          <label>
            审批策略
            <select
              value={approval}
              disabled={disabled}
              onChange={(event) => update('approvalPolicy', event.target.value)}
            >
              {!approval && (
                <option value="" disabled>
                  {unknown}
                </option>
              )}
              {approval === 'granular' && (
                <option value={approval} disabled>
                  {approvalLabels[approval]}
                </option>
              )}
              {['untrusted', 'on-request', 'never'].map((entry) => (
                <option key={entry} value={entry}>
                  {approvalLabels[entry]}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-observed">
            当前网络权限：
            {current?.networkAccess == null ? '未报告' : current.networkAccess ? '允许' : '受限'}
            <span>审批执行方：{current?.approvalReviewer ?? '未报告'}</span>
          </p>
          <p className="settings-note">
            {thread && !thread.managed ? '恢复后更新完整配置。' : ''}修改仅用于此
            {thread ? '会话的后续操作' : '项目的新会话'}，不更改全局配置。
            {pending &&
              ` 当前权限：${sandboxLabels[current?.sandbox ?? ''] ?? '未报告'}；审批：${approvalLabels[current?.approvalPolicy ?? ''] ?? '未报告'}。`}
            {settings.sandbox === 'danger-full-access' && '完全访问允许在沙箱外执行操作。'}
          </p>
        </div>
      )}
    </div>
  );
}
