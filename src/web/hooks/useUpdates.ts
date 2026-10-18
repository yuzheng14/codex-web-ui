import type { CodexUpdateConfirmation } from '../../shared/codex-compatibility';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReleaseChannel, UpdateSettings, UpdateStatus } from '../../shared/updates';
import { request } from '../lib/api';
import { reloadForUpgrade } from '../lib/upgrade-reload';

export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reloadError, setReloadError] = useState<string>();
  const reloading = useRef(false);
  const mounted = useRef(true);
  const revision = useRef(0);
  const accept = useCallback(async (next: UpdateStatus) => {
    if (!mounted.current) return;
    setStatus(next);
    setError(undefined);
    const builtVersion = import.meta.env.VITE_COVRO_VERSION as string | undefined;
    if (
      !import.meta.env.DEV &&
      builtVersion &&
      next.version !== 'unknown' &&
      next.version !== builtVersion &&
      !reloading.current &&
      (!next.run || next.run.committed || ['rolledBack', 'failed'].includes(next.run.phase))
    ) {
      reloading.current = true;
      try {
        await reloadForUpgrade();
      } catch (error) {
        reloading.current = false;
        setReloadError(error instanceof Error ? error.message : '草稿未能备份，暂缓重载页面');
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const started = revision.current;
      try {
        const next = await request<UpdateStatus>('/api/updates');
        if (active && started === revision.current) await accept(next);
      } catch {
        if (active) setError('连接暂时中断，正在等待服务恢复…');
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      mounted.current = false;
      active = false;
      clearInterval(timer);
    };
  }, [accept]);
  const perform = useCallback(
    async (path: string, body: object) => {
      revision.current++;
      setBusy(true);
      setError(undefined);
      try {
        await accept(await request<UpdateStatus>(path, body));
      } catch (error) {
        setError(error instanceof Error ? error.message : '操作未能确认，请查看升级状态');
      } finally {
        setBusy(false);
        revision.current++;
      }
    },
    [accept],
  );
  return {
    status,
    error,
    busy,
    reloadError,
    check: (channel: ReleaseChannel) => perform('/api/updates/check', { channel }),
    configure: (settings: UpdateSettings) => perform('/api/updates/settings', settings),
    start: (
      channel: ReleaseChannel,
      allowDowngrade: boolean,
      codexConfirmation?: CodexUpdateConfirmation,
    ) =>
      perform('/api/updates/run', {
        clientOperationId: crypto.randomUUID(),
        channel,
        allowDowngrade,
        codexConfirmation,
      }),
  };
}
export type Updates = ReturnType<typeof useUpdates>;
