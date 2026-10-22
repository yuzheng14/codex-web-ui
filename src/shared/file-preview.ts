/** Formats rendered literally, without parsing, executing or rewriting their contents. */
export const PLAIN_TEXT_EXTENSIONS = [
  'txt',
  'csv',
  'tsv',
  'toml',
  'yaml',
  'yml',
  'jsonl',
  'log',
  'ini',
] as const;

export function filePreviewFormat(path: string): 'markdown' | 'json' | 'text' | undefined {
  if (/\.(md|markdown)$/i.test(path)) return 'markdown';
  if (/\.json$/i.test(path)) return 'json';
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
  return PLAIN_TEXT_EXTENSIONS.some((value) => value === extension) ? 'text' : undefined;
}
