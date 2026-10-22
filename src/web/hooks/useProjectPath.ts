import { useEffect, useState } from 'react';
import { repositoryDirectory } from '../../shared/project-path';
import { api } from '../lib/api';
import { readableError } from '../lib/utils';

/** Keep the editable input separate from the host-resolved preview; ignore stale responses. */
export function useProjectPath(enabled: boolean, repository?: string) {
  const [input, setInput] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    path?: string;
    error?: string;
  }>();
  const directory = repository === undefined ? undefined : repositoryDirectory(repository);
  const key = JSON.stringify([input, directory, attempt]);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const timer = setTimeout(() => {
      void api.projectPath(input ?? '', directory).then(
        (preview) => {
          if (!stopped) setResult({ key, path: preview.path });
        },
        (problem: unknown) => {
          if (!stopped) setResult({ key, error: readableError(problem) });
        },
      );
    }, 150);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, input, directory, key]);
  const current = result?.key === key ? result : undefined;
  const value = input ?? current?.path ?? '';
  return {
    value,
    setValue: setInput,
    path: current?.path,
    error: current?.error,
    pending: enabled && !current,
    ready: Boolean(current?.path && !current.error && value.trim()),
    retry: () => setAttempt((value) => value + 1),
  };
}
