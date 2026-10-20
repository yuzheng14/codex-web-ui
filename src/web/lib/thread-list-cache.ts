import type { ThreadSummary } from '../../shared/types';
import { DeviceCache } from './device-cache';

export const THREAD_LIST_CACHE_ROWS = 300;
const storage = new DeviceCache();
const keyFor = (scope: string, project: string, archived: boolean) =>
  JSON.stringify([scope, project, 'thread-list', 'v1', archived ? 'archived' : 'active']);

/** Only reading metadata survives a visit. Runtime and replay state always come from the server. */
export function cachedSummary(row: ThreadSummary): ThreadSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    source: row.source,
    originator: row.originator,
    forkedFromId: row.forkedFromId,
    updatedAt: row.updatedAt,
    archived: Boolean(row.archived),
    historyVisible: row.historyVisible,
    status: 'unknown',
    managed: false,
    pendingActionCount: 0,
  };
}

export class ThreadListCache {
  constructor(readonly scope: string) {}
  async read(project: string, archived: boolean): Promise<ThreadSummary[] | undefined> {
    const rows = await storage.read<ThreadSummary[]>(keyFor(this.scope, project, archived));
    if (!Array.isArray(rows) || rows.length > THREAD_LIST_CACHE_ROWS) return;
    if (
      rows.some(
        (row) =>
          !row ||
          typeof row.id !== 'string' ||
          !row.id ||
          row.projectId !== project ||
          typeof row.title !== 'string' ||
          typeof row.source !== 'string' ||
          (row.originator != null && typeof row.originator !== 'string') ||
          (row.forkedFromId != null && typeof row.forkedFromId !== 'string') ||
          (row.updatedAt !== undefined && !Number.isFinite(row.updatedAt)) ||
          Boolean(row.archived) !== archived ||
          row.historyVisible === false,
      )
    )
      return;
    return [...new Map(rows.map((row) => [row.id, cachedSummary(row)])).values()];
  }
  write(project: string, archived: boolean, rows: ThreadSummary[]) {
    return storage.write(
      keyFor(this.scope, project, archived),
      rows
        .filter(
          (row) =>
            row.projectId === project &&
            Boolean(row.archived) === archived &&
            row.historyVisible !== false,
        )
        .slice(0, THREAD_LIST_CACHE_ROWS)
        .map(cachedSummary),
    );
  }
  remove(project: string) {
    return storage.remove(
      ([scope, projectId, kind, version]) =>
        scope === this.scope && projectId === project && kind === 'thread-list' && version === 'v1',
    );
  }
}
