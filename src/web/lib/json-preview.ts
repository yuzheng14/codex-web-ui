import { t } from '../i18n';
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
    return { error: t('preview:invalid_json_source_preserved_check_quotes_commas_and') };
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
      return { error: t('preview:json_is_too_deep_or_large_to_format') };
    previous = value;
  }
  return { tokens };
}
