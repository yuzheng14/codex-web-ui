import type { DiffHunk, DiffLine } from './diff';

export interface DiffSegment {
  text: string;
  changed: boolean;
}
export type HighlightedLine = DiffLine & { segments?: DiffSegment[] };
export type HighlightedHunk = Omit<DiffHunk, 'lines'> & { lines: HighlightedLine[] };

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const split = (text: string) => Array.from(graphemes.segment(text), (part) => part.segment);
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const splitWords = (parts: string[]) =>
  Array.from(words.segment(parts.join('')), (part) => part.segment);

function append(parts: DiffSegment[], text: string, changed: boolean) {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.changed === changed) previous.text += text;
  else parts.push({ text, changed });
}

/** Common edges keep very long replacements useful even when the LCS budget is exhausted. */
function compareText(before: string, after: string, budget: { cells: number }) {
  const left = split(before),
    right = split(after);
  const oldParts: DiffSegment[] = [],
    newParts: DiffSegment[] = [];
  let start = 0,
    end = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (
    end < left.length - start &&
    end < right.length - start &&
    left.at(-end - 1) === right.at(-end - 1)
  )
    end++;
  append(oldParts, left.slice(0, start).join(''), false);
  append(newParts, right.slice(0, start).join(''), false);
  const oldMiddle = splitWords(left.slice(start, left.length - end));
  const newMiddle = splitWords(right.slice(start, right.length - end));
  const cells = (oldMiddle.length + 1) * (newMiddle.length + 1);
  if (!oldMiddle.length || !newMiddle.length || cells > budget.cells) {
    append(oldParts, oldMiddle.join(''), true);
    append(newParts, newMiddle.join(''), true);
  } else {
    budget.cells -= cells;
    const columns = newMiddle.length + 1;
    const lengths = new Uint16Array(cells);
    for (let old = oldMiddle.length - 1; old >= 0; old--) {
      for (let next = newMiddle.length - 1; next >= 0; next--) {
        lengths[old * columns + next] =
          oldMiddle[old] === newMiddle[next]
            ? 1 + lengths[(old + 1) * columns + next + 1]!
            : Math.max(lengths[(old + 1) * columns + next]!, lengths[old * columns + next + 1]!);
      }
    }
    let old = 0,
      next = 0;
    while (old < oldMiddle.length || next < newMiddle.length) {
      if (old < oldMiddle.length && next < newMiddle.length && oldMiddle[old] === newMiddle[next]) {
        append(oldParts, oldMiddle[old++]!, false);
        append(newParts, newMiddle[next++]!, false);
      } else if (
        old < oldMiddle.length &&
        (next === newMiddle.length ||
          lengths[(old + 1) * columns + next]! >= lengths[old * columns + next + 1]!)
      ) {
        append(oldParts, oldMiddle[old++]!, true);
      } else append(newParts, newMiddle[next++]!, true);
    }
  }
  append(oldParts, left.slice(left.length - end).join(''), false);
  append(newParts, right.slice(right.length - end).join(''), false);
  return [oldParts, newParts] as const;
}

function signature(text: string) {
  // Bound pair scoring independently of the length of a source line.
  const trimmed = text.trim().slice(0, 4096);
  const tokens = new Map<string, number>();
  let size = 0;
  for (const token of trimmed.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []) {
    tokens.set(token, (tokens.get(token) ?? 0) + 1);
    size += token.length;
  }
  return { trimmed, tokens, size };
}
function similarity(left: ReturnType<typeof signature>, right: ReturnType<typeof signature>) {
  if (left.trimmed === right.trimmed) return 1;
  let common = 0,
    prefix = 0,
    suffix = 0;
  for (const [token, count] of left.tokens)
    common += Math.min(count, right.tokens.get(token) ?? 0) * token.length;
  const a = left.trimmed,
    b = right.trimmed;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a.at(-suffix - 1) === b.at(-suffix - 1)
  )
    suffix++;
  return Math.max(
    (2 * common) / Math.max(1, left.size + right.size),
    (prefix + suffix) / Math.max(1, a.length, b.length),
  );
}

/** Align related lines within each replacement block; extra or unrelated lines keep only row color. */
export function highlightDiffHunks(hunks: DiffHunk[]): HighlightedHunk[] {
  const textBudget = { cells: 200_000 };
  let alignmentBudget = 10_000;
  return hunks.map((hunk) => {
    const lines: HighlightedLine[] = [...hunk.lines];
    for (let start = 0; start < lines.length;) {
      if (lines[start]!.kind === 'context') {
        start++;
        continue;
      }
      let end = start;
      const removed: number[] = [],
        added: number[] = [];
      while (end < lines.length && lines[end]!.kind !== 'context') {
        if (lines[end]!.kind === 'removed') removed.push(end);
        if (lines[end]!.kind === 'added') added.push(end);
        end++;
      }
      const cells = (removed.length + 1) * (added.length + 1);
      if (removed.length && added.length && cells <= alignmentBudget) {
        alignmentBudget -= cells;
        const oldSignatures = removed.map((index) => signature(lines[index]!.text));
        const newSignatures = added.map((index) => signature(lines[index]!.text));
        const columns = added.length + 1;
        const scores = new Float64Array(cells);
        const pairs = new Uint8Array(cells);
        for (let old = removed.length - 1; old >= 0; old--) {
          for (let next = added.length - 1; next >= 0; next--) {
            const score = similarity(oldSignatures[old]!, newSignatures[next]!) * 2 - 0.5;
            const paired = score > 0 ? score + scores[(old + 1) * columns + next + 1]! : -1;
            const skipOld = scores[(old + 1) * columns + next]!;
            const skipNew = scores[old * columns + next + 1]!;
            scores[old * columns + next] = Math.max(paired, skipOld, skipNew);
            pairs[old * columns + next] =
              paired >= skipOld && paired >= skipNew ? 1 : skipOld >= skipNew ? 2 : 3;
          }
        }
        let old = 0,
          next = 0;
        while (old < removed.length && next < added.length) {
          const direction = pairs[old * columns + next];
          if (direction === 1) {
            const oldIndex = removed[old++]!,
              newIndex = added[next++]!;
            const before = lines[oldIndex]!,
              after = lines[newIndex]!;
            if (before.text !== after.text) {
              const [oldParts, newParts] = compareText(before.text, after.text, textBudget);
              lines[oldIndex] = { ...before, segments: oldParts };
              lines[newIndex] = { ...after, segments: newParts };
            }
          } else if (direction === 2) old++;
          else next++;
        }
      }
      start = end;
    }
    return { ...hunk, lines };
  });
}
