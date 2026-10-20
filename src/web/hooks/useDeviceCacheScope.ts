import { useEffect, useState } from 'react';
import type { Project, SystemInfo } from '../../shared/types';
import { api } from '../lib/api';
import type { ConnectionState } from '../lib/realtime';

/** One authenticated namespace shared by conversation pages and list summaries. */
export function useDeviceCacheScope(
  forbidden: boolean,
  connection: ConnectionState,
  projects: Project[],
  system?: SystemInfo,
) {
  const context = JSON.stringify([
    system?.codexEpoch,
    projects.map((project) => [project.id, project.rootPath, project.available]),
  ]);
  const [confirmed, setConfirmed] = useState<{ context: string; scope: string }>();
  useEffect(() => {
    if (forbidden) {
      setConfirmed(undefined);
      return;
    }
    let active = true;
    void api
      .historyCacheContext()
      .then(({ scope }) => {
        if (active) setConfirmed({ context, scope });
      })
      .catch(() => {
        // A confirmed identity remains usable during a transient outage.
      });
    return () => {
      active = false;
    };
  }, [forbidden, connection, context]);
  return !forbidden && confirmed?.context === context ? confirmed.scope : undefined;
}
