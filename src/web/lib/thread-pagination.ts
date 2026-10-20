import { scopeKey } from '../../shared/workspace-scope';
import { t } from '../i18n';
import type { ThreadSummaryPage } from '../../shared/types';

/** Ownership, visibility and live updates can still leave empty or duplicate CWD-filtered pages. */
export async function readThreadPage(options: {
  projectId: string;
  archived: boolean;
  cursor?: string;
  knownIds: Set<string>;
  read: (cursor?: string) => Promise<ThreadSummaryPage>;
  isCurrent: () => boolean;
}): Promise<ThreadSummaryPage | undefined> {
  let cursor = options.cursor;
  const visited = new Set<string>();
  let boundary: ThreadSummaryPage['cursor'] | undefined;
  const data = new Map<string, ThreadSummaryPage['data'][number]>();
  for (let count = 0; count < 100; count++) {
    if (!options.isCurrent()) return;
    if (cursor) visited.add(cursor);
    const page = await options.read(cursor);
    if (!options.isCurrent()) return;
    boundary ??= page.cursor;
    if (boundary.serverEpoch !== page.cursor.serverEpoch)
      throw new Error(t('sidebar:the_session_service_restarted_retry_loading_sessions'));
    if (page.nextCursor !== null && (!page.nextCursor || visited.has(page.nextCursor)))
      throw new Error(t('sidebar:session_pagination_did_not_advance_retry_or_refresh'));
    for (const thread of page.data) {
      if (
        scopeKey(thread.projectId) === options.projectId &&
        Boolean(thread.archived) === options.archived &&
        thread.historyVisible !== false
      )
        data.set(thread.id, thread);
    }
    if (page.nextCursor === null || [...data.keys()].some((id) => !options.knownIds.has(id)))
      return { data: [...data.values()], nextCursor: page.nextCursor, cursor: boundary };
    cursor = page.nextCursor;
  }
  throw new Error(t('sidebar:too_many_session_pages_read_retry_or_refresh'));
}
