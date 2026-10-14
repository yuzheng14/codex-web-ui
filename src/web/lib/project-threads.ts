import type { Cursor, ThreadSummary, ThreadSummaryPage } from '../../shared/types';

export interface ProjectThreads {
  data: ThreadSummary[];
  nextCursor: string | null;
  loading: boolean;
  error?: string;
}

interface Read {
  projectId: string;
  sequence: number;
  revision: number;
  append: boolean;
}

interface SummaryVersion {
  cursor: Cursor;
  revision: number;
}

const empty = (): ProjectThreads => ({ data: [], nextCursor: null, loading: false });
const sort = (threads: ThreadSummary[]) =>
  threads.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));

/** Independent overview state. Summaries never establish a conversation's replay cursor. */
export class ProjectThreadsStore {
  private value: Record<string, ProjectThreads> = {};
  private readonly sequences = new Map<string, number>();
  private readonly versions = new Map<string, SummaryVersion>();
  private revision = 0;

  get snapshot() {
    return this.value;
  }

  findProject(threadId: string) {
    return Object.entries(this.value).find(([, page]) =>
      page.data.some((thread) => thread.id === threadId),
    )?.[0];
  }

  removeProject(projectId: string) {
    // Keep the sequence as a tombstone so an older read cannot restore a removed project.
    this.sequences.set(projectId, (this.sequences.get(projectId) ?? 0) + 1);
    const next = { ...this.value };
    for (const thread of next[projectId]?.data ?? []) this.versions.delete(thread.id);
    delete next[projectId];
    this.value = next;
  }

  beginRead(projectId: string, append = false): Read {
    const sequence = (this.sequences.get(projectId) ?? 0) + 1;
    this.sequences.set(projectId, sequence);
    this.set(projectId, { ...this.get(projectId), loading: true, error: undefined });
    return { projectId, sequence, revision: this.revision, append };
  }

  finishRead(read: Read, page: ThreadSummaryPage) {
    if (this.sequences.get(read.projectId) !== read.sequence) return false;
    const previous = this.get(read.projectId);
    const data = new Map<string, ThreadSummary>(
      (read.append ? previous.data : []).map((entry) => [entry.id, entry]),
    );
    const newer = (id: string) => {
      const version = this.versions.get(id);
      return Boolean(
        version &&
        (version.cursor.serverEpoch === page.cursor.serverEpoch
          ? version.cursor.seq > page.cursor.seq
          : version.revision > read.revision),
      );
    };
    for (const entry of page.data) {
      if (entry.projectId !== read.projectId) continue;
      if (newer(entry.id)) {
        const current = previous.data.find((thread) => thread.id === entry.id);
        if (current) data.set(entry.id, current);
      } else {
        data.set(entry.id, entry);
        this.versions.set(entry.id, { cursor: page.cursor, revision: this.revision });
      }
    }
    // A newly created or newly active conversation may be absent from an older first page.
    for (const entry of previous.data) if (newer(entry.id)) data.set(entry.id, entry);
    this.set(read.projectId, {
      data: sort([...data.values()]),
      nextCursor: page.nextCursor,
      loading: false,
    });
    return true;
  }

  failRead(read: Read, error: string) {
    if (this.sequences.get(read.projectId) !== read.sequence) return false;
    this.set(read.projectId, { ...this.get(read.projectId), loading: false, error });
    return true;
  }

  applySummary(summary: ThreadSummary, cursor: Cursor) {
    const previousVersion = this.versions.get(summary.id);
    if (
      previousVersion?.cursor.serverEpoch === cursor.serverEpoch &&
      previousVersion.cursor.seq >= cursor.seq
    )
      return false;
    this.versions.set(summary.id, { cursor, revision: ++this.revision });
    const previous = this.get(summary.projectId);
    this.set(summary.projectId, {
      ...previous,
      data: sort([summary, ...previous.data.filter((entry) => entry.id !== summary.id)]),
    });
    return true;
  }

  private get(projectId: string) {
    return this.value[projectId] ?? empty();
  }

  private set(projectId: string, state: ProjectThreads) {
    this.value = { ...this.value, [projectId]: state };
  }
}
