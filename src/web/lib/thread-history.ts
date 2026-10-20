import { t } from '../i18n';
import type { ThreadView, TurnView } from '../../shared/types';

/** Replace whole turns by stable ID: snapshots can correct items, status and output. */
export function mergeHistoryTurns(older: TurnView[], newer: TurnView[]): TurnView[] {
  const replacements = new Map(newer.map((turn) => [turn.id, turn]));
  const known = new Set(older.map((turn) => turn.id));
  return [
    ...older.map((turn) => replacements.get(turn.id) ?? turn),
    ...newer.filter((turn) => !known.has(turn.id)),
  ];
}

export interface HistoryChunk {
  cursor: string;
  page: ThreadView;
}

/** History pages never replace live metadata, actions, or execution ownership. */
export class HistoryWindow {
  readonly chunks: HistoryChunk[] = [];
  constructor(public latest: ThreadView) {}
  update(latest: ThreadView) {
    this.latest = latest;
    if (!latest.history || latest.history.olderCursor === null) this.chunks.length = 0;
  }
  get cursor(): string | null {
    return (
      (this.chunks.length ? this.chunks.at(-1)!.page : this.latest).history?.olderCursor ?? null
    );
  }
  append(cursor: string, page: ThreadView) {
    if (page.id !== this.latest.id || page.projectId !== this.latest.projectId)
      throw new Error(t('errors:this_history_chunk_does_not_belong_to_the'));
    if (this.cursor !== cursor || this.chunks.some((chunk) => chunk.cursor === cursor)) return;
    if (
      page.history?.olderCursor &&
      (page.history.olderCursor === cursor ||
        this.chunks.some((chunk) => chunk.cursor === page.history!.olderCursor))
    )
      throw new Error(t('errors:history_pagination_did_not_advance_retry_syncing_the'));
    this.chunks.push({ cursor, page });
  }
  replace(cursor: string, page: ThreadView) {
    const index = this.chunks.findIndex((chunk) => chunk.cursor === cursor);
    if (index < 0) return this.append(cursor, page);
    if (page.id !== this.latest.id || page.projectId !== this.latest.projectId)
      throw new Error(t('errors:this_history_chunk_does_not_belong_to_the'));
    const previous = this.chunks[index]!;
    this.chunks[index] = { cursor, page };
    if (previous.page.history?.olderCursor !== page.history?.olderCursor)
      this.chunks.splice(index + 1);
  }
  /** Locate the authoritative page without fetching unrelated history. */
  getHistoryCursor(targetId: string): string | undefined {
    const contains = (page: ThreadView) =>
      page.turns.some(
        (turn) => turn.id === targetId || turn.items.some((item) => item.id === targetId),
      );
    if (contains(this.latest)) return undefined;
    return this.chunks.find((chunk) => contains(chunk.page))?.cursor;
  }
  get view(): ThreadView {
    let turns: TurnView[] = [];
    for (const chunk of this.chunks.slice().reverse())
      turns = mergeHistoryTurns(turns, chunk.page.turns);
    return {
      ...this.latest,
      turns: mergeHistoryTurns(turns, this.latest.turns),
      history: { olderCursor: this.cursor },
    };
  }
}
