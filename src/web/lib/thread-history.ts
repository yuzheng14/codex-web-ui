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
      throw new Error('历史分片不属于当前会话。');
    if (this.cursor !== cursor || this.chunks.some((chunk) => chunk.cursor === cursor)) return;
    if (
      page.history?.olderCursor &&
      (page.history.olderCursor === cursor ||
        this.chunks.some((chunk) => chunk.cursor === page.history!.olderCursor))
    )
      throw new Error('历史分页未前进，请重试同步会话。');
    this.chunks.push({ cursor, page });
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
