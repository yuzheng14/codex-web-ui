import type {
  Cursor,
  ThreadSummary,
  ThreadSummaryPage,
  ThreadMutationResult,
} from '../../shared/types';

import type { SavedOperation, ThreadMutation } from './operations';

export interface ProjectThreads {
  data: ThreadSummary[];
  nextCursor: string | null;
  loading: boolean;
  appending?: boolean;
  cacheBlocked?: boolean;
  error?: string;
  retryCursor?: string;
  loaded?: boolean;
  /** Cached rows not yet observed in this server pagination pass. */
  unverified?: string[];
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
  private readonly authoritative = new Map<string, ThreadSummary>();
  private revision = 0;
  private readonly seen = new Map<string, Set<string>>();
  archived = false;
  private readonly mutations = new Map<
    string,
    {
      target: string;
      change: ThreadMutation;
      base?: ThreadSummary;
      revision: number;
    }
  >();

  constructor(operations: SavedOperation[] = []) {
    for (const entry of operations)
      if (entry.mutation) this.beginMutation(entry.clientOperationId, entry.target, entry.mutation);
  }

  beginMutation(id: string, target: string, change: ThreadMutation, base?: ThreadSummary) {
    base ??= Object.values(this.value)
      .flatMap((page) => page.data)
      .find((row) => row.id === target);
    this.mutations.set(id, { target, change, base, revision: this.revision });
  }

  seedMutation(id: string, base: ThreadSummary) {
    const mutation = this.mutations.get(id);
    if (
      mutation &&
      !mutation.base &&
      mutation.target === base.id &&
      mutation.change.projectId === base.projectId
    )
      mutation.base = base;
  }

  project<T extends { id: string }>(thread: T): T {
    let next = thread;
    for (const { target, change } of this.mutations.values())
      if (target === thread.id)
        next = {
          ...next,
          ...(change.archived === undefined ? {} : { archived: change.archived }),
          ...(change.title === undefined ? {} : { title: change.title }),
        };
    return next;
  }

  settleMutation(id: string, result?: ThreadMutationResult) {
    const mutation = this.mutations.get(id);
    if (!mutation) return;
    if (
      result?.summary?.id === mutation.target &&
      result.summary.projectId === mutation.change.projectId &&
      result.cursor
    ) {
      const version = this.versions.get(mutation.target);
      // A recovered receipt from a previous gateway must not overwrite a newer epoch.
      if (
        !version ||
        version.cursor.serverEpoch === result.cursor.serverEpoch ||
        version.revision <= mutation.revision
      )
        this.applySummary(result.summary, result.cursor);
    }
    if (mutation.base) {
      // A failed write may have outlived a filter change; restore only its own row.
      const previous = this.get(mutation.change.projectId);
      if (!previous.data.some((row) => row.id === mutation.target) && this.includes(mutation.base))
        this.set(mutation.change.projectId, {
          ...previous,
          data: sort([...previous.data, mutation.base]),
        });
    }
    this.mutations.delete(id);
    return mutation.base;
  }

  setArchived(archived: boolean) {
    if (this.archived === archived) return false;
    this.archived = archived;
    for (const projectId of this.sequences.keys())
      this.sequences.set(projectId, this.sequences.get(projectId)! + 1);
    this.value = {};
    this.seen.clear();
    return true;
  }

  private includes(summary: ThreadSummary) {
    return summary.historyVisible !== false && Boolean(summary.archived) === this.archived;
  }

  get snapshot() {
    if (!this.mutations.size) return this.value;
    const value = { ...this.value };
    for (const { change, base } of this.mutations.values()) {
      const page = value[change.projectId] ?? empty();
      const data = new Map(page.data.map((row) => [row.id, row]));
      if (base && !data.has(base.id)) data.set(base.id, base);
      value[change.projectId] = { ...page, data: [...data.values()] };
    }
    for (const [projectId, page] of Object.entries(value))
      value[projectId] = {
        ...page,
        data: sort(page.data.map((row) => this.project(row)).filter((row) => this.includes(row))),
      };
    return value;
  }

  /** Persist authoritative rows, never the optimistic projection. */
  cacheRows(projectId: string) {
    return this.value[projectId]?.data;
  }

  discardCached() {
    let changed = false;
    for (const [id, page] of Object.entries(this.value)) {
      if (!page.unverified?.length) continue;
      const unverified = new Set(page.unverified);
      this.set(id, {
        ...page,
        data: page.data.filter((row) => !unverified.has(row.id)),
        unverified: [],
      });
      changed = true;
    }
    return changed;
  }

  restoreCached(projectId: string, rows: ThreadSummary[]) {
    const previous = this.get(projectId);
    if (previous.cacheBlocked || (previous.loaded && previous.nextCursor === null)) return false;
    const data = new Map(previous.data.map((row) => [row.id, row]));
    const unverified = new Set(previous.unverified);
    for (const saved of rows) {
      const known = this.authoritative.get(saved.id);
      const row = known ?? saved;
      if (row.projectId !== projectId || !this.includes(row) || data.has(row.id)) continue;
      data.set(row.id, row);
      if (!known) unverified.add(row.id);
    }
    if (data.size === previous.data.length) return false;
    this.set(projectId, {
      ...previous,
      data: sort([...data.values()]),
      unverified: [...unverified],
    });
    return true;
  }

  findProject(threadId: string) {
    return Object.entries(this.value).find(([, page]) =>
      page.data.some((thread) => thread.id === threadId),
    )?.[0];
  }

  removeProject(projectId: string) {
    for (const [id, mutation] of this.mutations)
      if (mutation.change.projectId === projectId) this.mutations.delete(id);
    // Keep the sequence as a tombstone so an older read cannot restore a removed project.
    this.sequences.set(projectId, (this.sequences.get(projectId) ?? 0) + 1);
    const next = { ...this.value };
    for (const [id, thread] of this.authoritative)
      if (thread.projectId === projectId) {
        this.authoritative.delete(id);
        this.versions.delete(id);
      }
    delete next[projectId];
    this.seen.delete(projectId);
    this.value = next;
  }

  beginRead(projectId: string, append = false): Read {
    const sequence = (this.sequences.get(projectId) ?? 0) + 1;
    this.sequences.set(projectId, sequence);
    this.set(projectId, {
      ...this.get(projectId),
      loading: true,
      appending: append,
      error: undefined,
      retryCursor: undefined,
    });
    return { projectId, sequence, revision: this.revision, append };
  }

  isCurrent(read: Read) {
    return this.sequences.get(read.projectId) === read.sequence;
  }

  finishRead(read: Read, page: ThreadSummaryPage) {
    if (!this.isCurrent(read)) return false;
    const previous = this.get(read.projectId);
    const data = new Map<string, ThreadSummary>(
      (read.append || page.nextCursor !== null ? previous.data : []).map((entry) => [
        entry.id,
        entry,
      ]),
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
    const seen = read.append
      ? (this.seen.get(read.projectId) ?? new Set<string>())
      : new Set<string>();
    const unverified = new Set(previous.unverified);
    for (const entry of page.data) {
      if (entry.projectId !== read.projectId) continue;
      seen.add(entry.id);
      unverified.delete(entry.id);
      if (newer(entry.id)) {
        const current = this.authoritative.get(entry.id);
        if (current && this.includes(current)) data.set(entry.id, current);
        else data.delete(entry.id);
      } else {
        if (this.includes(entry)) data.set(entry.id, entry);
        else data.delete(entry.id);
        this.versions.set(entry.id, { cursor: page.cursor, revision: ++this.revision });
        this.authoritative.set(entry.id, entry);
        for (const mutation of this.mutations.values())
          if (mutation.target === entry.id) mutation.base = entry;
      }
    }
    // A newly created or newly active conversation may be absent from an older first page.
    for (const entry of this.authoritative.values())
      if (entry.projectId === read.projectId && this.includes(entry) && newer(entry.id)) {
        data.set(entry.id, entry);
        seen.add(entry.id);
      }
    this.seen.set(read.projectId, seen);
    // Absence is authoritative only after traversing the complete current result, never one page.
    if (page.nextCursor === null)
      for (const entry of [...previous.data, ...this.authoritative.values()]) {
        if (
          entry.projectId !== read.projectId ||
          !this.includes(entry) ||
          seen.has(entry.id) ||
          newer(entry.id)
        )
          continue;
        data.delete(entry.id);
        // Retain absence across filter changes so an older persistent snapshot cannot resurrect it.
        this.authoritative.set(entry.id, { ...entry, historyVisible: false });
        this.versions.set(entry.id, { cursor: page.cursor, revision: ++this.revision });
      }
    this.set(read.projectId, {
      data: sort([...data.values()]),
      unverified: page.nextCursor === null ? [] : [...unverified],
      nextCursor: page.nextCursor,
      loading: false,
      loaded: true,
    });
    return true;
  }

  failRead(read: Read, error: string, retryCursor?: string, forbidden = false) {
    if (!this.isCurrent(read)) return false;
    this.set(read.projectId, {
      ...(forbidden ? empty() : this.get(read.projectId)),
      loading: false,
      error,
      retryCursor,
      cacheBlocked: forbidden,
    });
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
    this.authoritative.set(summary.id, summary);
    for (const mutation of this.mutations.values())
      if (mutation.target === summary.id) mutation.base = summary;
    const previous = this.get(summary.projectId);
    if (this.includes(summary)) this.seen.get(summary.projectId)?.add(summary.id);
    this.set(summary.projectId, {
      ...previous,
      unverified: previous.unverified?.filter((id) => id !== summary.id),
      data: sort([
        ...(this.includes(summary) ? [summary] : []),
        ...previous.data.filter((entry) => entry.id !== summary.id),
      ]),
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
