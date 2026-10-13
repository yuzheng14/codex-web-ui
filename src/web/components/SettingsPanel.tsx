import type { ModelInfo, Settings } from '../../shared/types';

export function SettingsPanel({
  settings,
  models,
  onChange,
}: {
  settings: Settings;
  models: ModelInfo[];
  onChange: (settings: Settings) => void;
}) {
  const selectedModel = models.find((model) => model.id === settings.model);
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
        运行设置 <span>{selectedModel?.name ?? '继承 Codex 配置'}</span>
      </summary>
      <div className="settings-fields">
        <label>
          模型
          <select
            value={settings.model ?? ''}
            onChange={(event) => update('model', event.target.value)}
          >
            <option value="">继承 Codex 配置</option>
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
            <option value="">继承 Codex 配置</option>
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
          {settings.sandbox === 'danger-full-access' && '完全访问允许在沙箱外执行操作。'}
        </p>
      </div>
    </details>
  );
}
