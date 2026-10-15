import { expect, it } from 'vitest';
import { parseTitle, titlePrompt } from '../../src/codex/thread-title-policy.js';

it.each(['中文任务'.repeat(500), '🧑🏽‍💻'.repeat(500), 'a'.repeat(2000)])(
  'bounds the whole prompt to 960 UTF-8 bytes without splitting Unicode',
  (text) => {
    const prompt = titlePrompt(`  ${text}\n`);
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(960);
    expect(prompt).toContain('at most 36 characters');
    expect(prompt).toContain('Preserve ticket references exactly.');
    const message = prompt.split('User prompt:\n')[1]!;
    expect(text.startsWith(message)).toBe(true);
    expect(message).not.toContain('\uFFFD');
    expect(Buffer.byteLength(prompt + [...text.slice(message.length)][0])).toBeGreaterThan(960);
  },
);

it.each([
  ['  “  Fix\n ABC-123 login!  ”  ', 'Fix ABC-123 login'],
  ['#123 Fix login???', '#123 Fix login'],
  ['修复登录失败。', '修复登录失败。'],
  ['😃'.repeat(50), '😃'.repeat(36)],
  ['""', undefined],
])('normalizes and truncates the CLI title format: %s', (title, expected) => {
  expect(parseTitle(JSON.stringify({ title }))).toBe(expected);
});

it.each([
  'plain title',
  '[]',
  '{"title":null}',
  '{"title":"OK","other":1}',
  '```json\n{"title":"OK"}\n```',
])('rejects invalid structured output: %s', (output) => expect(parseTitle(output)).toBeUndefined());
