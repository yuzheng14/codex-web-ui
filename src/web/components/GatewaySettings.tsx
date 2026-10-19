import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Download, Upload, Settings2 } from 'lucide-react';
import type {
  GatewayConfig,
  GatewayConfigImport,
  GatewayConfigSnapshot,
} from '../../shared/gateway-config';
import { api, HttpError } from '../lib/api';
import {
  configChanges,
  configFields,
  configForm,
  formConfig,
  type ConfigField,
  type ConfigForm,
} from '../lib/gateway-config';
import { Button } from './ui/button';
import { Icon } from './Icon';

const message = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试。');

export function GatewaySettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<GatewayConfigSnapshot>();
  const [form, setForm] = useState<ConfigForm>();
  const [review, setReview] = useState<GatewayConfig>();
  const [imported, setImported] = useState<GatewayConfigImport>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty =
    !!snapshot &&
    !!form &&
    JSON.stringify(formConfig(form, snapshot.saved)) !== JSON.stringify(snapshot.saved);

  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    void api
      .gatewayConfig()
      .then((next) => {
        if (!controller.signal.aborted) {
          setSnapshot(next);
          setForm(configForm(next.saved));
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(message(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      dialog.current?.close();
    };
  }, []);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);

  const close = () => {
    if (busy) return;
    if (dirty || imported) setConfirmClose(true);
    else onClose();
  };
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      setError(message(failure));
      if (failure instanceof HttpError && failure.problem.code === 'CONFIG_CONFLICT')
        setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    await run(async () => {
      const next = await api.gatewayConfig();
      setSnapshot(next);
      setForm(configForm(next.saved));
      setReview(undefined);
      setImported(undefined);
      setConflict(false);
    });
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await run(async () => {
      if (file.size > 256 * 1024) throw new Error('配置文件不能超过 256 KiB。');
      let value: unknown;
      try {
        value = JSON.parse(await file.text());
      } catch {
        throw new Error('无法解析 JSON，请检查配置文件格式。');
      }
      setImported(await api.importGatewayConfig(value));
      setReview(undefined);
    });
  }
  async function exportFile() {
    await run(async () => {
      const saved = await api.exportGatewayConfig();
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(saved, null, 2)}\n`], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'codex-web-config.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('已导出配置文件中的已保存配置；未保存的编辑不包含在内。');
    });
  }
  const running = snapshot && configForm(snapshot.running);
  const preview = imported?.config ?? review;
  const changes = snapshot && preview ? configChanges(snapshot.saved, preview) : [];
  function field(item: ConfigField) {
    if (!form || !running) return null;
    if (['issuer', 'audience'].includes(item.key) && form.mode !== 'cloudflare-access') return null;
    const props = {
      id: `gateway-${item.key}`,
      'aria-labelledby': `gateway-${item.key}-label`,
      'aria-describedby': `gateway-${item.key}-help`,
      value: form[item.key],
      disabled: busy || !snapshot?.writable,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setForm({ ...form, [item.key]: event.target.value });
        setNotice('');
      },
    };
    return (
      <label className="project-field" key={item.key} htmlFor={props.id}>
        <span id={`gateway-${item.key}-label`}>{item.label}</span>
        {'multiline' in item ? (
          <textarea {...props} rows={3} spellCheck={false} />
        ) : (
          <input {...props} type={'type' in item ? item.type : 'text'} spellCheck={false} />
        )}
        <small id={`gateway-${item.key}-help`}>{item.help}</small>
        {form[item.key] !== running[item.key] && (
          <small className="gateway-running">当前运行：{running[item.key] || '未设置'}</small>
        )}
      </label>
    );
  }

  return (
    <dialog
      ref={dialog}
      className="project-dialog gateway-dialog"
      aria-labelledby="gateway-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <Settings2 size={20} aria-hidden="true" />
          <h2 id="gateway-title">服务配置</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭服务配置"
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" size={17} />
        </Button>
      </div>
      <p className="gateway-intro">配置运行此网页服务的电脑。保存后需手动重启服务生效。</p>
      {error && (
        <p className="gateway-error" role="alert">
          {error}
        </p>
      )}
      {!snapshot && (
        <Button variant="secondary" disabled={busy} onClick={() => void reload()}>
          {busy ? '正在读取配置…' : '重新读取配置'}
        </Button>
      )}
      {snapshot && form && (
        <>
          <div className="gateway-file">
            <span>配置文件</span>
            <code>{snapshot.path}</code>
          </div>
          <div className="gateway-status" role="status" data-pending={snapshot.restartRequired}>
            <strong>
              {snapshot.restartRequired ? '已保存，待重启生效' : '已保存配置与当前运行配置一致'}
            </strong>
            <span>保存不会重启服务或中断当前任务。</span>
          </div>
          {!snapshot.writable && <p className="gateway-error">{snapshot.readOnlyReason}</p>}
          {notice && (
            <p className="gateway-notice" role="status">
              {notice}
            </p>
          )}
          {conflict && (
            <div className="gateway-conflict">
              <p>重新读取会丢弃当前编辑，并载入文件的最新内容。</p>
              <Button variant="secondary" disabled={busy} onClick={() => void reload()}>
                丢弃编辑并重新读取
              </Button>
            </div>
          )}
          {confirmClose ? (
            <section className="gateway-review" aria-label="放弃编辑确认">
              <h3>放弃未保存的更改？</h3>
              <p>配置文件尚未修改。</p>
              <div className="project-dialog-actions">
                <Button variant="secondary" onClick={() => setConfirmClose(false)}>
                  继续编辑
                </Button>
                <Button variant="destructive" onClick={onClose}>
                  放弃更改并关闭
                </Button>
              </div>
            </section>
          ) : preview ? (
            <section
              className="gateway-review"
              aria-label={imported ? '导入配置预览' : '保存配置预览'}
            >
              <h3>{imported ? '预览导入配置' : '确认配置更改'}</h3>
              <p>
                {imported
                  ? '应用到表单后仍需检查并保存，才会修改配置文件。导入将替换当前表单中的可编辑配置。'
                  : '以下更改将在服务重启后生效。请确认新的访问地址和认证配置。'}
              </p>
              {imported && (
                <p>
                  保留当前数据目录和项目初始配置。
                  {imported.preserved.length > 0
                    ? `已忽略导入文件中的 ${imported.preserved.join('、')}。`
                    : ''}
                </p>
              )}
              {changes.length ? (
                <div className="gateway-changes">
                  {changes.map((change) => (
                    <div key={change.label}>
                      <strong>{change.label}</strong>
                      <span>已保存：{change.before || '未设置'}</span>
                      <span>更改为：{change.after || '未设置'}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p>与已保存配置没有差异。</p>
              )}
              <details className="gateway-json">
                <summary>查看完整 JSON</summary>
                <pre>{JSON.stringify(preview, null, 2)}</pre>
              </details>
              <div className="project-dialog-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setImported(undefined);
                    setReview(undefined);
                  }}
                >
                  返回编辑
                </Button>
                {imported ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setForm(configForm(imported.config));
                      setImported(undefined);
                      setNotice('导入配置已应用到表单，尚未保存。');
                    }}
                  >
                    应用到表单
                  </Button>
                ) : (
                  <Button
                    disabled={busy || conflict || !changes.length}
                    onClick={() =>
                      void run(async () => {
                        const next = await api.saveGatewayConfig(snapshot.revision, preview);
                        setSnapshot(next);
                        setForm(configForm(next.saved));
                        setReview(undefined);
                        setNotice(
                          next.restartRequired
                            ? '配置已保存。请在方便时手动重启服务。'
                            : '配置已保存，与当前运行配置一致。',
                        );
                      })
                    }
                  >
                    {busy ? '正在保存…' : '确认保存'}
                  </Button>
                )}
              </div>
            </section>
          ) : (
            <>
              <div className="gateway-tools">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !snapshot.writable}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={15} aria-hidden="true" />
                  导入配置
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void exportFile()}
                >
                  <Download size={15} aria-hidden="true" />
                  导出已保存配置
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".json,application/json"
                  aria-label="选择配置文件"
                  hidden
                  onChange={(event) => void importFile(event)}
                />
              </div>
              <p className="gateway-help">
                导入仅更新服务设置；导出包含文件中的项目初始配置，不包含页面注册项目、会话、数据库或登录凭据。
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    setReview(
                      (await api.importGatewayConfig(formConfig(form, snapshot.saved))).config,
                    );
                  });
                }}
              >
                <fieldset disabled={busy || !snapshot.writable}>
                  <section className="gateway-section">
                    <h3>网络与访问</h3>
                    <div className="gateway-fields">
                      {configFields.filter((item) => item.group === 'network').map(field)}
                      <label className="project-field">
                        <span>认证模式</span>
                        <select
                          aria-label="认证模式"
                          value={form.mode}
                          onChange={(event) =>
                            setForm({ ...form, mode: event.target.value as ConfigForm['mode'] })
                          }
                        >
                          <option value="local">本机 / Tailscale（local）</option>
                          <option value="cloudflare-access">Cloudflare Access</option>
                        </select>
                        <small>
                          本机模式仅监听回环地址；公开互联网入口使用 Cloudflare Access。
                        </small>
                        {form.mode !== running?.mode && (
                          <small className="gateway-running">当前运行：{running?.mode}</small>
                        )}
                      </label>
                    </div>
                  </section>
                  <section className="gateway-section">
                    <h3>Codex</h3>
                    <div className="gateway-fields">
                      {configFields.filter((item) => item.group === 'codex').map(field)}
                    </div>
                  </section>
                  <section className="gateway-section">
                    <h3>数据与项目</h3>
                    <div className="gateway-file">
                      <span>数据目录（只读）</span>
                      <code>{snapshot.saved.dataDir}</code>
                      <span>当前运行目录</span>
                      <code>{snapshot.running.dataDir}</code>
                    </div>
                    <p className="gateway-help">
                      数据目录变更需要迁移数据库，请在服务停止后处理。项目请在侧栏添加、重命名或移除；此处不覆盖已保存的项目管理结果。
                    </p>
                  </section>
                  <details className="gateway-section">
                    <summary>高级设置</summary>
                    <div className="gateway-fields">
                      {configFields.filter((item) => item.group === 'advanced').map(field)}
                    </div>
                  </details>
                </fieldset>
                <div className="gateway-save-bar">
                  <span>{dirty ? '有未保存的更改' : '没有未保存的更改'}</span>
                  <Button type="submit" disabled={busy || !dirty || !snapshot.writable || conflict}>
                    {busy ? '正在校验…' : '检查更改'}
                  </Button>
                </div>
              </form>
            </>
          )}
        </>
      )}
    </dialog>
  );
}
