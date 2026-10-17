import { eq } from 'drizzle-orm';
import type { AppDatabase } from './index.js';
import { turnUsage } from './schema.js';
import type { TurnView } from '../../shared/types.js';

export class TurnUsageStore {
  constructor(private readonly database: AppDatabase) {}

  save(threadId: string, turn: TurnView): void {
    if (
      turn.outputTokens === undefined ||
      !Number.isSafeInteger(turn.outputTokens) ||
      turn.outputTokens < 0
    )
      return;
    this.database
      .insert(turnUsage)
      .values({
        threadId,
        turnId: turn.id,
        outputTokens: turn.outputTokens,
      })
      .onConflictDoNothing()
      .run();
  }

  restore(threadId: string, turns: TurnView[]): TurnView[] {
    if (turns.length === 0) return turns;
    const saved = new Map(
      this.database
        .select()
        .from(turnUsage)
        .where(eq(turnUsage.threadId, threadId))
        .all()
        .map((entry) => [entry.turnId, entry.outputTokens]),
    );
    return turns.map((turn) => {
      const outputTokens = saved.get(turn.id);
      return outputTokens === undefined ? turn : { ...turn, outputTokens };
    });
  }
}
