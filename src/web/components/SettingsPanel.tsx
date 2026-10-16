import { useEffect, useId, useState, type ReactNode } from 'react';
import type { ModelInfo, Settings, ThreadView } from '../../shared/types';
import { useRuntimeDefaults } from '../hooks/useRuntimeDefaults';
import { chooseModel, pendingSettings } from '../lib/settings';
import { Icon } from './Icon';
import { ReasoningGauge } from './ReasoningGauge';
import { ControlHint } from './ControlHint';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

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
const approvalShortLabels: Record<string, string> = {
  untrusted: '操作审批',
  'on-request': '按需审批',
  never: '无需审批',
  granular: '自定义审批',
};

export function SettingsPanel({
  settings,
  projectName,
  children,
  models,
  thread,
  projectId,
  runtimeKey,
  disabled,
  threadLoading,
  onChange,
}: {
  settings: Settings;
  projectName?: string;
  children: ReactNode;
  models: ModelInfo[];
  thread?: ThreadView;
  projectId?: string;
  runtimeKey?: string;
  disabled: boolean;
  threadLoading?: boolean;
  onChange: (settings: Settings) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [permissionMenu, setPermissionMenu] = useState<'sandbox' | 'approval' | null>(null);
  const advancedId = useId();
  const effortHintId = useId();
  useEffect(() => {
    setModelMenuOpen(false);
    setEffortMenuOpen(false);
    setPermissionMenu(null);
  }, [disabled, thread?.id, projectId]);
  const defaults = useRuntimeDefaults(thread || threadLoading ? undefined : projectId, runtimeKey);
  const current = thread ? thread.runtimeSettings : defaults.value;
  const unknown = threadLoading || (defaults.loading && !thread) ? '读取中…' : '未报告';
  const model = settings.model ?? current?.model ?? '';
  const effort = settings.reasoningEffort ?? current?.reasoningEffort ?? '';
  const sandbox = settings.sandbox ?? current?.sandbox ?? '';
  const approval = settings.approvalPolicy ?? current?.approvalPolicy ?? '';
  const selectedModel = models.find((entry) => entry.id === model);
  const changes = pendingSettings(settings, current);
  const pending = Object.keys(changes).length > 0;
  const source = thread ? (thread.managed ? '会话当前配置' : '会话保存配置') : '新会话默认配置';
  const policyLabel = approvalShortLabels[approval] ?? `审批${unknown}`;
  function update(key: keyof Settings, value: string) {
    onChange(pendingSettings({ ...settings, [key]: value }, current));
  }
  return (
    <div className="settings-panel" role="group" aria-label="运行设置">
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
            <Select
              value={sandbox}
              disabled={disabled}
              open={permissionMenu === 'sandbox'}
              onOpenChange={(open) => setPermissionMenu(open ? 'sandbox' : null)}
              onValueChange={(value) => update('sandbox', value)}
            >
              <SelectTrigger aria-label="权限范围" data-value={sandbox}>
                <SelectValue placeholder={unknown}>{sandboxLabels[sandbox] ?? unknown}</SelectValue>
              </SelectTrigger>
              <SelectContent aria-label="权限范围">
                {sandbox === 'external-sandbox' && (
                  <SelectItem value={sandbox} disabled>
                    {sandboxLabels[sandbox]}
                  </SelectItem>
                )}
                {['read-only', 'workspace-write', 'danger-full-access'].map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {sandboxLabels[entry]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label>
            审批策略
            <Select
              value={approval}
              disabled={disabled}
              open={permissionMenu === 'approval'}
              onOpenChange={(open) => setPermissionMenu(open ? 'approval' : null)}
              onValueChange={(value) => update('approvalPolicy', value)}
            >
              <SelectTrigger aria-label="审批策略" data-value={approval}>
                <SelectValue placeholder={unknown}>
                  {approvalLabels[approval] ?? unknown}
                </SelectValue>
              </SelectTrigger>
              <SelectContent aria-label="审批策略">
                {approval === 'granular' && (
                  <SelectItem value={approval} disabled>
                    {approvalLabels[approval]}
                  </SelectItem>
                )}
                {['untrusted', 'on-request', 'never'].map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {approvalLabels[entry]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
      <div className="composer-actions">
        <div className="composer-context">
          <span className="composer-target" title={projectName ?? '未选择项目'}>
            <Icon name="folder" size={14} />
            <span>{projectName ?? '未选择项目'}</span>
          </span>
          <button
            className="settings-policy"
            type="button"
            aria-label="权限与审批设置"
            title={`审批策略：${approvalLabels[approval] ?? unknown}；权限范围：${sandboxLabels[sandbox] ?? unknown}`}
            aria-expanded={expanded}
            aria-controls={advancedId}
            onClick={() => setExpanded(!expanded)}
          >
            <Icon name="shield" size={16} />
            <span>{policyLabel}</span>
            <Icon name="down" size={11} />
          </button>
        </div>
        <div className="composer-send-controls">
          <Select
            value={model}
            disabled={disabled || !models.length}
            open={modelMenuOpen}
            onOpenChange={setModelMenuOpen}
            onValueChange={(value) => {
              const selected = models.find((entry) => entry.id === value);
              if (selected) onChange(chooseModel(settings, current, selected));
            }}
          >
            <SelectTrigger
              className="settings-choice settings-model"
              aria-label="模型"
              title={`模型：${model || unknown}`}
              data-value={model}
            >
              <span className="settings-model-value">
                <SelectValue placeholder={unknown}>{model || unknown}</SelectValue>
              </span>
            </SelectTrigger>
            <SelectContent side="top" aria-label="模型">
              {model && !selectedModel && (
                <SelectItem value={model} disabled>
                  {model}
                </SelectItem>
              )}
              {models.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={effort}
            disabled={disabled || !selectedModel?.reasoningEfforts.length}
            open={effortMenuOpen}
            onOpenChange={setEffortMenuOpen}
            onValueChange={(value) => update('reasoningEffort', value)}
          >
            <ControlHint
              id={effortHintId}
              suppressed={effortMenuOpen}
              content={
                <>
                  <span>推理强度：{effort || unknown}</span>
                  {changes.reasoningEffort !== undefined && (
                    <span>待应用 · 当前 {current?.reasoningEffort ?? unknown}</span>
                  )}
                </>
              }
            >
              <SelectTrigger
                className="settings-choice settings-effort"
                aria-label="推理强度"
                aria-describedby={effortHintId}
                data-value={effort}
              >
                <ReasoningGauge effort={effort} />
                <span className="sr-only">
                  <SelectValue placeholder={unknown}>{effort || unknown}</SelectValue>
                </span>
              </SelectTrigger>
            </ControlHint>
            <SelectContent side="top" aria-label="推理强度">
              {effort && !selectedModel?.reasoningEfforts.includes(effort) && (
                <SelectItem value={effort} disabled>
                  {effort}
                </SelectItem>
              )}
              {selectedModel?.reasoningEfforts.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {entry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {children}
        </div>
      </div>
    </div>
  );
}
