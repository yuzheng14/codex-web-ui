import { AppError } from '../shared/errors.js';
import type { ItemView, ThreadView } from '../shared/types.js';
import { isActive } from './projection.js';

const truncated = '[内容已截断；可通过 HTTP 历史读取完整的已保留内容]';
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const preview = (value: string, length = 512): string =>
  value.length > length ? `${value.slice(0, length)}\n${truncated}` : value;

/** A bounded transport copy; the server's authoritative projection stays intact. */
export function compactThreadForTransport(thread: ThreadView, maxBytes: number): ThreadView {
  const result = structuredClone(thread);
  let size = bytes(result);
  if (size <= maxBytes) return result;
  result.historyTruncated = true;
  size = bytes(result);
  const mutate = (object: unknown, update: () => void) => {
    const before = bytes(object);
    update();
    size += bytes(object) - before;
  };
  const compactItem = (item: ItemView) =>
    mutate(item, () => {
      item.truncated = true;
      if (item.text !== undefined) item.text = preview(item.text);
      if (item.output !== undefined) item.output = preview(item.output);
      if (item.command !== undefined) item.command = preview(item.command);
      if (item.error !== undefined) item.error = preview(item.error);
      if (item.details !== undefined) item.details = truncated;
      if (item.changes)
        item.changes = item.changes.map((change) => ({ ...change, diff: preview(change.diff) }));
    });
  // Remove old output first, preserving turn/item IDs and all current controls.
  for (const turn of result.turns) {
    if (turn.diff)
      mutate(turn, () => {
        turn.diff = preview(turn.diff!);
      });
    for (const item of turn.items) {
      if (size <= maxBytes) return result;
      compactItem(item);
    }
  }
  // Active and last turns retain their identities even if older history must be omitted.
  const lastTurnId = result.turns.at(-1)?.id;
  for (let index = 0; size > maxBytes && index < result.turns.length;) {
    const turn = result.turns[index]!;
    if (turn.id !== lastTurnId && !isActive(turn.status) && turn.status !== 'unknown') {
      mutate(result.turns, () => {
        result.turns.splice(index, 1);
      });
    } else index++;
  }
  for (const turn of result.turns) {
    while (size > maxBytes && turn.items.length > 0)
      mutate(turn.items, () => {
        turn.items.shift();
      });
    if (size <= maxBytes) return result;
  }
  // Large display-only approval context can be shortened; legal options/questions are preserved.
  for (const action of result.actions) {
    mutate(action, () => {
      delete action.details;
      if (action.command) action.command = preview(action.command);
      if (action.reason) action.reason = preview(action.reason);
      action.title = preview(action.title);
      if (action.questions)
        for (const question of action.questions)
          for (const option of question.options)
            option.description = preview(option.description, 120);
    });
    if (size <= maxBytes) return result;
  }
  if (size > maxBytes) {
    // Never silently remove a pending question or alter the values needed to answer it.
    throw new AppError(
      'SNAPSHOT_TOO_LARGE',
      '控制信息超出连接缓冲限制，请提高 wsBytes 后重连；完整历史仍可通过 HTTP 读取',
      413,
    );
  }
  return result;
}
