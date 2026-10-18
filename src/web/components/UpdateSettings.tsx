import type { CodexCompatibility } from '../../shared/codex-compatibility';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, ExternalLink } from 'lucide-react';
import { releaseChannels, updateActive, type ReleaseChannel } from '../../shared/updates';
import type { Updates } from '../hooks/useUpdates';
import { Button } from './ui/button';
import { Icon } from './Icon';

const labels: Record<ReleaseChannel, string> = { stable: '稳定版', beta: '预览版', dev: '开发版' };
const phaseLabels = {
  installing: '正在安装候选版本',
  waiting: '等待任务空闲',
  stopping: '正在备份并重启',
  verifying: '正在验证新版',
  succeeded: '升级成功',
  rolledBack: '已恢复上一版本',
  failed: '升级失败',
};
const compatibilityLabels = {
  verified: '已验证',
  unverified: '尚未验证',
  unsupported: '明确不支持',
  unknown: '无法确认',
};
function CodexCompatibilityDetails({ title, value }: { title: string; value: CodexCompatibility }) {
  return (
    <section className="update-codex" aria-label={title} data-state={value.status}>
      <h3>{title}</h3>
      <div>
        <span>Codex CLI</span>
        <strong>{value.version ?? '未识别'}</strong>
        <span className="update-codex-status">{compatibilityLabels[value.status]}</span>
      </div>
      {value.manifest && (
        <p className="subtle">
          推荐：{value.manifest.recommended} · 已验证：{value.manifest.verified.join('、')}
        </p>
      )}
      {value.reason && <p>{value.reason}</p>}
    </section>
  );
}
export function UpdateSettings({ updates, onClose }: { updates: Updates; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { status, busy, error, reloadError } = updates;
  const [selectedChannel, setChannel] = useState<ReleaseChannel>();
  const channel = selectedChannel ?? status?.settings.channel ?? 'stable';
  const [allowDowngrade, setAllowDowngrade] = useState(false);
  const selected = status?.available?.channel === channel ? status.available : undefined;
  const active = updateActive(status?.run);
  const current = selected?.version === status?.version;
  const [codexConsent, setCodexConsent] = useState<string>();
  const identity = JSON.stringify([channel, selected?.version, selected?.codex]);
  const confirmedCodex = codexConsent === identity;
  const compatibility = selected?.codex;
  const needsCodexConsent = !current && compatibility?.status === 'unverified';
  const codexBlocked =
    !current &&
    selected &&
    (!compatibility ||
      compatibility.status === 'unknown' ||
      compatibility.status === 'unsupported' ||
      (needsCodexConsent && !confirmedCodex));
  useEffect(() => {
    setCodexConsent(undefined);
  }, [identity]);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="project-dialog update-dialog"
      aria-labelledby="update-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <ArrowUpCircle size={20} aria-hidden="true" />
          <h2 id="update-title">Covro 更新</h2>
        </div>
        <Button variant="ghost" size="icon" aria-label="关闭更新设置" onClick={onClose}>
          <Icon name="close" size={17} />
        </Button>
      </div>
      <div className="update-version">
        <span>当前 Covro</span>
        <strong>{status?.version ?? '读取中…'}</strong>
        {status?.commit && <code>{status.commit.slice(0, 8)}</code>}
      </div>
      {status?.codex && <CodexCompatibilityDetails title="当前 Codex" value={status.codex} />}
      <label className="update-channel">
        版本渠道
        <select
          aria-label="版本渠道"
          value={channel}
          disabled={busy || active}
          onChange={(event) => {
            const next = event.target.value as ReleaseChannel;
            setChannel(next);
            setAllowDowngrade(false);
            setCodexConsent(undefined);
            void updates.check(next);
          }}
        >
          {releaseChannels.map((entry) => (
            <option key={entry} value={entry}>
              {labels[entry]}
            </option>
          ))}
        </select>
      </label>
      <p className="subtle">
        {channel === 'stable'
          ? '经过验证的正式版本，适合日常使用。'
          : channel === 'beta'
            ? '提前体验准备发布的功能。'
            : '跟随通过检查的 main 提交，适合开发者体验和验证新功能。'}
      </p>
      <div className="update-control">
        <div>
          <strong>空闲时自动升级</strong>
          <p className="subtle">定期检查当前渠道，已验证的 Codex 组合在任务结束后安装并重启。</p>
        </div>
        <Button
          role="switch"
          aria-label="空闲时自动升级"
          aria-checked={status?.settings.automatic ?? false}
          variant="secondary"
          size="sm"
          disabled={busy || active || !status?.supported}
          onClick={() =>
            status &&
            void updates.configure({ ...status.settings, automatic: !status.settings.automatic })
          }
        >
          {status?.settings.automatic ? '已开启' : '已关闭'}
        </Button>
      </div>
      {status && channel !== status.settings.channel && (
        <p className="subtle">
          当前订阅：{labels[status.settings.channel]}。成功更新后切换到{labels[channel]}。
        </p>
      )}
      {selected && (
        <div className="update-available">
          <span>
            {current ? '此渠道已是当前版本' : selected.downgrade ? '目标版本' : '可用版本'}
          </span>
          <strong>{selected.version}</strong>
          {selected.commit && <code>{selected.commit.slice(0, 8)}</code>}
        </div>
      )}
      {selected?.codex && (
        <CodexCompatibilityDetails title="目标版本兼容性" value={selected.codex} />
      )}
      {needsCodexConsent && (
        <label className="update-downgrade update-codex-consent">
          <input
            type="checkbox"
            aria-label="允许尝试未验证的 Codex 组合"
            checked={confirmedCodex}
            disabled={busy || active}
            onChange={(event) => setCodexConsent(event.target.checked ? identity : undefined)}
          />
          我确认尝试 Codex {compatibility?.version} 与 Covro {selected?.version}{' '}
          的未验证组合；此确认仅用于本次升级。
        </label>
      )}
      {selected &&
        !current &&
        selected.channel === status?.settings.channel &&
        status.settings.automatic &&
        compatibility?.status !== 'verified' && (
          <p className="update-notice" role="status">
            {compatibility?.status === 'unverified'
              ? '自动升级已暂停。可以调整 Codex 版本后重新检查，或勾选确认后手动尝试。'
              : '自动升级已暂停。请先恢复 Codex 连接、调整版本或等待含有效兼容声明的发行版，再重新检查。'}
          </p>
        )}
      <div className="update-buttons">
        <Button
          variant="secondary"
          disabled={busy || active}
          onClick={() => void updates.check(channel)}
        >
          {busy ? '正在处理…' : '检查更新'}
        </Button>
        <Button
          disabled={
            busy ||
            active ||
            !selected ||
            !status?.supported ||
            Boolean(codexBlocked) ||
            (selected.downgrade && !allowDowngrade) ||
            (current && channel === status.settings.channel)
          }
          onClick={() =>
            void updates.start(
              channel,
              allowDowngrade,
              needsCodexConsent && confirmedCodex && selected?.codex.version
                ? { version: selected.codex.version, target: selected.version }
                : undefined,
            )
          }
        >
          {current ? '使用此渠道' : selected?.downgrade ? '切换并重启' : '升级并重启'}
        </Button>
      </div>
      {selected?.downgrade && (
        <label className="update-downgrade">
          <input
            type="checkbox"
            checked={allowDowngrade}
            onChange={(event) => setAllowDowngrade(event.target.checked)}
          />
          允许降级；数据库不兼容时仍会阻止切换
        </label>
      )}
      {status?.run && (
        <section className="update-progress" data-phase={status.run.phase} role="status">
          <strong>{phaseLabels[status.run.phase]}</strong>
          <span>
            {status.run.from} → {status.run.target}
          </span>
          <p>{status.run.message}</p>
          {active && <progress aria-label="升级进度" />}
        </section>
      )}
      {(error || status?.checkError || reloadError) && (
        <p className="inline-error" role="alert">
          {reloadError ?? error ?? status?.checkError}
        </p>
      )}
      {!status?.supported && status?.unsupportedReason && (
        <p className="update-notice">{status.unsupportedReason}</p>
      )}
      <p className="update-source">
        版本来源：npm 官方 registry · {channel === 'stable' ? 'latest' : channel}
        <a
          href="https://github.com/yuzheng14/codex-web-ui/releases"
          target="_blank"
          rel="noreferrer"
        >
          更新记录 <ExternalLink size={12} aria-hidden="true" />
        </a>
      </p>
      <p className="subtle">
        升级保留配置、项目和会话记录。页面关闭也会继续处理，重启后自动恢复连接。
      </p>
    </dialog>
  );
}
