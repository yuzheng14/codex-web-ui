import { describe, expect, it } from 'vitest';
import { startTurnSchema, steerSchema } from '../../src/shared/validation.js';

const clientOperationId = 'be1ce8c0-c87e-4a42-92cd-ef9f77e019df';

describe.each([
  { name: 'start turn', schema: startTurnSchema, input: { clientOperationId } },
  {
    name: 'steer turn',
    schema: steerSchema,
    input: { clientOperationId, expectedTurnId: 'turn-1' },
  },
])('$name text contract', ({ schema, input }) => {
  it('preserves indentation, trailing whitespace, and line endings exactly', () => {
    for (const text of ['\tfirst line\n\tsecond line\n', '  第一行  \r\n  第二行\t\r\n']) {
      expect(schema.parse({ ...input, text }).text).toBe(text);
    }
  });

  it('rejects empty or whitespace-only text', () => {
    for (const text of ['', ' ', '\t\r\n', '\u3000\u00a0']) {
      expect(schema.safeParse({ ...input, text }).success).toBe(false);
    }
  });

  it('applies the length limit to the original text, including surrounding whitespace', () => {
    const text = ` ${'x'.repeat(99_998)}\n`;
    expect(schema.safeParse({ ...input, text }).success).toBe(true);
    expect(schema.safeParse({ ...input, text: `${text}\n` }).success).toBe(false);
  });
});
