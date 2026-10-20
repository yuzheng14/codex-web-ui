/** Positions come from the Markdown AST, so fences inside other code are never inspected. */
export function isClosedCodeFence(source: string): boolean {
  const lines = source.trimEnd().split('\n');
  const opening = /^(`{3,}|~{3,})/.exec(lines[0] ?? '');
  const closing = /^(?:[ \t]*>[ \t]?)*[ \t]*(`+|~+)[ \t]*$/.exec(lines.at(-1) ?? '');
  return !!(
    lines.length > 1 &&
    opening?.[1] &&
    closing?.[1] &&
    closing[1][0] === opening[1][0] &&
    closing[1].length >= opening[1].length
  );
}
