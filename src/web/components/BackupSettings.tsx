import { useEffect, useRef, useState } from 'react';
import { DatabaseBackup, RefreshCw, ShieldCheck } from 'lucide-react';
import type { BackupRecord, BackupStatus } from '../../shared/backups';
import { request } from '../lib/api';
import { Button } from './ui/button';
import { Icon } from './Icon';

const phases: Record<BackupRecord['phase'], string> = {
  waiting: '等待安全点',
  copying: '正在备份',
  verifying: '正在验证',
  succeeded: '备份成功',
  failed: '备份失败',
  cancelled: '已取消',
  interrupted: '备份已中断',
  corrupt: '备份不可用',
};
const triggers = { manual: '手动备份', preUpgrade: '升级前备份', preRestore: '恢复前备份' };
function size(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;
}
export function BackupSettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<BackupStatus>();
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const generation = useRef(0);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pendingId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const active = status?.active;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const revision = generation.current;
      try {
        const next = await request<BackupStatus>('/api/backups', undefined, controller.signal);
        if (controller.signal.aborted || revision !== generation.current) return;
        setLoadError(undefined);
        setStatus(next);
        if (next.records.some((record) => record.id === pendingId.current))
          pendingId.current = undefined;
      } catch (failure) {
        if (!controller.signal.aborted)
          setLoadError(failure instanceof Error ? failure.message : '无法读取备份记录。');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      mounted.current = false;
      controller.abort();
      clearTimeout(timer);
      element?.close();
    };
  }, []);
  async function act(path: string, body: object, success?: string) {
    generation.current++;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await request<BackupStatus>(path, body);
      if (mounted.current) {
        setStatus(next);
        setNotice(success);
        pendingId.current = undefined;
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '备份操作失败。');
    } finally {
      generation.current++;
      if (mounted.current) setBusy(false);
    }
  }
  const records = status?.records ?? [];
  const complete = records.filter((record) => record.phase === 'succeeded');
  const total = complete.reduce(
    (sum, record) =>
      sum + (record.manifest?.files.reduce((bytes, file) => bytes + file.size, 0) ?? 0),
    0,
  );
  return (
    <dialog
      ref={dialog}
      className="project-dialog backup-dialog"
      aria-labelledby="backup-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <DatabaseBackup size={20} aria-hidden="true" />
          <h2 id="backup-title">备份与恢复</h2>
        </div>
        <Button variant="ghost" size="icon" aria-label="关闭备份与恢复" onClick={onClose}>
          <Icon name="close" size={17} />
        </Button>
      </div>
      <p className="subtle">
        备份保存在运行服务的电脑上。等待任务、审批和待核对操作结束后生成快照，不中断正在运行的任务。
      </p>
      <section className="backup-summary" aria-label="备份概况">
        <span>
          当前 Schema <strong>{status?.schemaVersion ?? '…'}</strong>
        </span>
        <span>
          已完成 <strong>{complete.length}</strong> 份 · {size(total)}
        </span>
      </section>
      <div className="backup-actions">
        <Button
          disabled={!status?.supported || busy || Boolean(active)}
          onClick={() => {
            pendingId.current ??= crypto.randomUUID();
            void act('/api/backups', { clientOperationId: pendingId.current });
          }}
        >
          <DatabaseBackup size={16} aria-hidden="true" />
          {busy ? '正在处理…' : '立即备份'}
        </Button>
        {active && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void act(`/api/backups/${encodeURIComponent(active.id)}/cancel`, {})}
          >
            取消备份
          </Button>
        )}
      </div>
      {active && (
        <section className="backup-progress" role="status" aria-label="备份进度">
          <strong>{phases[active.phase]}</strong>
          <p>{active.message}</p>
          {active.phase !== 'waiting' && (
            <progress aria-label="数据库备份进度" max={100} value={active.progress} />
          )}
          <p className="subtle">关闭此页面后，服务仍会继续处理。</p>
        </section>
      )}
      {(error || loadError) && (
        <p className="inline-error" role="alert">
          {error ?? loadError}
        </p>
      )}
      {notice && (
        <p className="backup-notice" role="status">
          <ShieldCheck size={16} aria-hidden="true" />
          {notice}
        </p>
      )}
      {status?.unsupportedReason && <p className="inline-error">{status.unsupportedReason}</p>}
      <h3>备份记录</h3>
      {!status && !error && !loadError && <p className="subtle">正在读取备份记录…</p>}
      {status && !records.length && (
        <p className="backup-empty">还没有备份。创建第一份快照，或在升级前自动创建。</p>
      )}
      <ol className="backup-records">
        {records.map((record) => (
          <li key={record.id} className="backup-record" data-phase={record.phase}>
            <div className="backup-record-heading">
              <strong>{phases[record.phase]}</strong>
              <span>{triggers[record.trigger]}</span>
            </div>
            <time dateTime={new Date(record.createdAt).toISOString()}>
              {new Date(record.createdAt).toLocaleString()}
            </time>
            {record.manifest && (
              <p>
                Covro {record.manifest.appVersion} · Schema {record.manifest.schemaVersion} ·{' '}
                {size(record.manifest.files.reduce((sum, file) => sum + file.size, 0))}
              </p>
            )}
            <p
              className="backup-record-message"
              role={
                ['failed', 'corrupt', 'interrupted'].includes(record.phase) ? 'alert' : undefined
              }
            >
              {record.message}
            </p>
            {record.manifest?.protectedBy && <p className="subtle">升级修复保留 · 请勿清理</p>}
            <code className="backup-path">{record.path}</code>
            {record.manifest && !['waiting', 'copying', 'verifying'].includes(record.phase) && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || Boolean(active)}
                onClick={() =>
                  void act(
                    `/api/backups/${encodeURIComponent(record.id)}/verify`,
                    {},
                    '备份已重新验证，可按当前版本的恢复流程使用。',
                  )
                }
              >
                <RefreshCw size={13} aria-hidden="true" />
                重新验证
              </Button>
            )}
            {record.phase === 'succeeded' && (
              <details className="backup-restore">
                <summary>恢复方式</summary>
                <p>
                  先在服务端终端预检，停服后用相同备份 ID
                  确认恢复。恢复会覆盖配置和应用数据，并丢弃备份之后的应用数据。
                </p>
                <code>
                  covro backup restore {record.id} --config{' '}
                  {JSON.stringify(record.manifest?.configPath)}
                </code>
                <p>预检会显示覆盖范围、兼容性及后续确认步骤。</p>
              </details>
            )}
          </li>
        ))}
      </ol>
      <section className="backup-scope" aria-label="备份范围与保留策略">
        <h3>范围与保留</h3>
        <p>
          包含 Covro 服务配置、项目注册、偏好和应用数据库记录。Codex
          会话正文、凭据、附件与产物、项目文件需要分别备份。
        </p>
        <p>备份不自动清理。升级修复依赖的备份应保留；恢复前的原始文件副本也会占用磁盘。</p>
        {status && (
          <>
            <span>存储目录</span>
            <code className="backup-path">{status.directory}</code>
          </>
        )}
      </section>
    </dialog>
  );
}
