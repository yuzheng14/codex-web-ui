import { isRecord } from './transport.js';

// Keep in sync with codex-rs/tui/src/app/thread_title.rs (rust-v0.164.0).
export const TITLE_MODEL = 'gpt-5.6-luna';
export const TITLE_MAX_CHARS = 36;
const PROMPT_MAX_BYTES = 960;
export const TITLE_RESPONSE_MAX_BYTES = 8 * 1024;
export const titleOutputSchema = {
  type: 'object',
  properties: { title: { type: 'string', minLength: 1, maxLength: TITLE_MAX_CHARS } },
  required: ['title'],
  additionalProperties: false,
};
const instructions =
  'Generate a concise, single-line task title of at most 36 characters and under five words where possible. ' +
  'Start with an imperative verb. Capitalize only the first word unless the ' +
  "user's language, proper nouns, acronyms, or code terms require otherwise. " +
  "Preserve ticket references exactly. Write in the user's language. " +
  'Do not use quotes, markdown, or trailing punctuation. Do not answer the request.';

export function titlePrompt(message: string): string {
  const prefix = `${instructions}\n\nUser prompt:\n`;
  let remaining = PROMPT_MAX_BYTES - Buffer.byteLength(prefix);
  let text = '';
  for (const character of message.trim()) {
    remaining -= Buffer.byteLength(character);
    if (remaining < 0) break;
    text += character;
  }
  return prefix + text;
}

export function parseTitle(response: string): string | undefined {
  if (Buffer.byteLength(response) > TITLE_RESPONSE_MAX_BYTES) return;
  let value: unknown;
  try {
    value = JSON.parse(response);
  } catch {
    return;
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.title !== 'string')
    return;
  const title = value.title
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.?!]+$/u, '')
    .trimEnd();
  return title ? [...title].slice(0, TITLE_MAX_CHARS).join('') : undefined;
}

export function selectTitleModel(
  currentModel: string,
  provider: string,
  hasChatgptAccount: boolean,
  models: readonly string[],
): string {
  return provider === 'openai' && hasChatgptAccount && models.includes(TITLE_MODEL)
    ? TITLE_MODEL
    : currentModel;
}
