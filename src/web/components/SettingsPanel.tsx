import { useEffect, useId, useState, type ReactNode } from 'react';
import type { ModelInfo, Settings, ThreadView } from '../../shared/types';
import { useRuntimeDefaults } from '../hooks/useRuntimeDefaults';
import { chooseModel, pendingSettings } from '../lib/settings';
import { Icon } from './Icon';
import { PermissionDetails, PermissionModeSelect } from './PermissionModeSelect';
import { permissionModes } from '../../shared/permissions';
import { permissionLabel } from '../lib/settings';
import { ReasoningGauge } from './ReasoningGauge';
import { ControlHint } from './ControlHint';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

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
  const advancedId = useId();
  const effortHintId = useId();
  useEffect(() => {
    setModelMenuOpen(false);
    setEffortMenuOpen(false);
  }, [disabled, thread?.id, projectId]);
  useEffect(() => setExpanded(false), [thread?.id, projectId]);
  const defaults = useRuntimeDefaults(
    thread?.managed || threadLoading ? undefined : projectId,
    runtimeKey,
  );
  const current = thread ? thread.runtimeSettings : defaults.value;
  // A saved/occupied thread has no effective permission query. Defaults supply availability
  // for a future fork only; never use their permission values as the thread's actual state.
  const permissions =
    current?.permissionCapabilities || thread?.managed
      ? current
      : {
          ...current,
          model: current?.model ?? null,
          reasoningEffort: current?.reasoningEffort ?? null,
          permissionCapabilities: defaults.value?.permissionCapabilities,
        };
  const unknown = threadLoading || (defaults.loading && !thread) ? '读取中…' : '未报告';
  const model = settings.model ?? current?.model ?? '';
  const effort = settings.reasoningEffort ?? current?.reasoningEffort ?? '';
  const selectedModel = models.find((entry) => entry.id === model);
  const changes = pendingSettings(settings, current);
  const pending = Object.keys(changes).length > 0;
  const source = thread ? (thread.managed ? '会话当前配置' : '会话保存配置') : '新会话默认配置';
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
            {changes.permissionMode &&
              ` · 权限待生效：${permissionModes[changes.permissionMode].label}；当前：${permissionLabel(current)}`}
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
          <PermissionDetails
            current={permissions}
            source={source}
            settings={changes}
            thread={Boolean(thread)}
            unknown={unknown}
          />
        </div>
      )}
      <div className="composer-actions">
        <div className="composer-context">
          <span className="composer-target" title={projectName ?? '未选择项目'}>
            <Icon name="folder" size={14} />
            <span>{projectName ?? '未选择项目'}</span>
          </span>
          <PermissionModeSelect
            settings={changes}
            current={permissions}
            unknown={unknown}
            disabled={disabled || Boolean(threadLoading)}
            scope={`${projectId}:${thread?.id ?? ''}:${runtimeKey}`}
            onChange={onChange}
          />
          <button
            className="settings-details-toggle"
            type="button"
            aria-label="权限详情"
            title="权限详情"
            aria-expanded={expanded}
            aria-controls={advancedId}
            onClick={() => setExpanded(!expanded)}
          >
            <Icon name="settings" size={14} />
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
