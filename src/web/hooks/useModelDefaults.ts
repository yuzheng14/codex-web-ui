import { useEffect, useState } from 'react';
import type { ModelSettings } from '../../shared/types';
import { api } from '../lib/api';

/** A project or runtime change must never show another project's defaults. */
export function useModelDefaults(projectId?: string, runtimeKey?: string) {
  const [attempt, setAttempt] = useState(0);
  const key = projectId && runtimeKey ? JSON.stringify([projectId, runtimeKey, attempt]) : '';
  const [result, setResult] = useState<{
    key: string;
    value?: ModelSettings;
    error?: string;
  }>();
  useEffect(() => {
    if (!key || !projectId) return;
    let cancelled = false;
    void api.modelSettings(projectId).then(
      (value) => {
        if (!cancelled) setResult({ key, value });
      },
      () => {
        if (!cancelled) setResult({ key, error: '无法读取默认配置' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, projectId]);
  return {
    value: result?.key === key ? result.value : undefined,
    error: result?.key === key ? result.error : undefined,
    loading: Boolean(key && result?.key !== key),
    retry: () => setAttempt((value) => value + 1),
  };
}
