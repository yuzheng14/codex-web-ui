import type { ModelInfo, Settings, ThreadView } from '../../shared/types';
import { useModelDefaults } from '../hooks/useModelDefaults';

export function SettingsPanel({
  settings,
  models,
  thread,
  projectId,
  runtimeKey,
  onChange,
}: {
  settings: Settings;
  models: ModelInfo[];
  thread?: ThreadView;
  projectId?: string;
  runtimeKey?: string;
  onChange: (settings: Settings) => void;
}) {
  const defaults = useModelDefaults(thread ? undefined : projectId, runtimeKey);
  const current = thread ? thread.modelSettings : defaults.value;
  const model = current?.model ?? (defaults.loading && !thread ? '读取中…' : '未报告');
  const effort = current?.reasoningEffort ?? (defaults.loading && !thread ? '读取中…' : '未报告');
  const source = thread ? (thread.managed ? '会话当前配置' : '会话保存配置') : '新会话默认配置';
  const selectedModel = models.find((model) => model.id === (settings.model ?? current?.model));
  const modelChanged = settings.model !== undefined && settings.model !== current?.model;
  const pending =
    modelChanged ||
    (settings.reasoningEffort !== undefined &&
      settings.reasoningEffort !== current?.reasoningEffort);
  const inheritedEffort = modelChanged ? '由 Codex 确认' : effort;
  function update(key: keyof Settings, value: string) {
    const next = { ...settings };
    if (value === '') delete next[key];
    else Object.assign(next, { [key]: value });
    if (key === 'model') delete next.reasoningEffort;
    onChange(next);
  }
  return (
    <details className="settings-panel">
      <summary>
        运行设置{' '}
        <span>
          {model} · {effort}
        </span>
      </summary>
      <div className="settings-fields">
        <div className="settings-current" aria-live="polite">
          <p>
            {source}：<strong>{model}</strong> · 推理强度 <strong>{effort}</strong>
          </p>
          {pending && (
            <p className="settings-pending">
              下次使用：{settings.model ?? model} · {settings.reasoningEffort ?? inheritedEffort}
              （待 Codex 确认）
            </p>
          )}
          {!thread && defaults.error && (
            <p>
              {defaults.error}{' '}
              <button type="button" onClick={defaults.retry}>
                重试
              </button>
            </p>
          )}
          {current && (!current.model || !current.reasoningEffort) && (
            <p>未报告表示尚未设置或无法读取，以 Codex 返回为准。</p>
          )}
        </div>
        <label>
          模型
          <select
            value={settings.model ?? ''}
            onChange={(event) => update('model', event.target.value)}
          >
            <option value="">继承（{model}）</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          推理强度
          <select
            value={settings.reasoningEffort ?? ''}
            onChange={(event) => update('reasoningEffort', event.target.value)}
            disabled={!selectedModel}
          >
            <option value="">继承（{inheritedEffort}）</option>
            {selectedModel?.reasoningEfforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
        <label>
          权限范围
          <select
            value={settings.sandbox ?? ''}
            onChange={(event) => update('sandbox', event.target.value)}
          >
            <option value="">继承 Codex 配置</option>
            <option value="read-only">只读</option>
            <option value="workspace-write">项目内写入</option>
            <option value="danger-full-access">完全访问</option>
          </select>
        </label>
        <label>
          审批策略
          <select
            value={settings.approvalPolicy ?? ''}
            onChange={(event) => update('approvalPolicy', event.target.value)}
          >
            <option value="">继承 Codex 配置</option>
            <option value="untrusted">不可信操作需审批</option>
            <option value="on-request">由 Codex 请求审批</option>
            <option value="never">不请求审批</option>
          </select>
        </label>
        <p className="settings-note">
          设置作用于新建、恢复会话及下一轮任务；不覆盖本机全局配置。
          继承会沿用会话设置，不会重置为全局默认值。
          {settings.sandbox === 'danger-full-access' && '完全访问允许在沙箱外执行操作。'}
        </p>
      </div>
    </details>
  );
}
