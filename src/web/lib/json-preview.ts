export interface JsonToken {
  text: string;
  kind?: 'key' | 'string' | 'number' | 'boolean' | 'null';
}

type JsonPreview = { tokens: JsonToken[]; error?: never } | { tokens?: never; error: string };

/** Validate without reserializing: large numbers, duplicate keys and escapes stay literal. */
export function formatJson(content: string): JsonPreview {
  const input = content.replace(/^\uFEFF/, '');
  try {
    JSON.parse(input);
  } catch {
    return { error: 'JSON 格式无效，已保留原文。请检查引号、逗号及括号是否完整。' };
  }

  const tokens: JsonToken[] = [];
  const pattern =
    /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g;
  let depth = 0;
  let length = 0;
  let previous = '';
  for (const match of input.matchAll(pattern)) {
    const value = match[0];
    const closing = value === '}' || value === ']';
    const empty = closing && (previous === '{' || previous === '[');
    if (closing) depth--;
    const prefix =
      (closing && !empty) || previous === ',' || previous === '{' || previous === '['
        ? empty
          ? ''
          : '\n' + '  '.repeat(depth)
        : previous === ':'
          ? ' '
          : '';
    const kind = value.startsWith('"')
      ? /^\s*:/.test(input.slice(match.index! + value.length))
        ? 'key'
        : 'string'
      : value === 'null'
        ? 'null'
        : value === 'true' || value === 'false'
          ? 'boolean'
          : /^-?\d/.test(value)
            ? 'number'
            : undefined;
    tokens.push({ text: prefix + value, kind });
    length += prefix.length + value.length;
    if (value === '{' || value === '[') depth++;
    // Bound indentation expansion and DOM work for otherwise valid, hostile-sized input.
    if (depth > 100 || length > 4 * 1024 * 1024 || tokens.length > 30_000)
      return { error: 'JSON 层级过深或内容过多，无法格式化预览。已保留原文供查看。' };
    previous = value;
  }
  return { tokens };
}
