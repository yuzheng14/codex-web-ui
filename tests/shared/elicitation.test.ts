import { describe, expect, it } from 'vitest';
import {
  normalizeElicitationRequest,
  normalizeElicitationSchema,
  validateElicitationResolution,
  validatePermissionResolution,
} from '../../src/shared/elicitation.js';
import type { ActionResolution, ElicitationValue } from '../../src/shared/types.js';

const form = (properties: Record<string, unknown>, required: string[] = []) =>
  normalizeElicitationRequest({
    serverName: 'test-server',
    mode: 'form',
    requestedSchema: { type: 'object', properties, required },
  });

describe('MCP elicitation form contract', () => {
  it('retains primitive values, Unicode length and omitted optional fields', () => {
    const request = form(
      {
        approved: { type: 'boolean', default: false },
        count: { type: 'integer', minimum: 0, maximum: 2 },
        note: { type: 'string', minLength: 1, maxLength: 1 },
        optional: { type: 'string' },
      },
      ['approved', 'count', 'note'],
    );
    expect(request.schemaError).toBeUndefined();
    expect(
      validateElicitationResolution(request, {
        decision: 'accept',
        content: { approved: false, count: 0, note: '😀' },
      }),
    ).toEqual({ approved: false, count: 0, note: '😀' });
    expect(() =>
      validateElicitationResolution(request, {
        decision: 'accept',
        content: { count: 0, note: '😀' },
      }),
    ).toThrow('approved');
  });

  it('maps titled, legacy and multiple selection choices without substituting display labels', () => {
    const request = form(
      {
        titled: { type: 'string', oneOf: [{ const: 'internal', title: '显示名称' }] },
        legacy: { type: 'string', enum: [''], enumNames: ['空值'] },
        multi: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: {
            anyOf: [
              { const: 'a', title: '甲' },
              { const: 'b', title: '乙' },
            ],
          },
        },
      },
      ['titled', 'legacy', 'multi'],
    );
    expect(request.fields?.[0]?.options).toEqual([{ value: 'internal', label: '显示名称' }]);
    expect(
      validateElicitationResolution(request, {
        decision: 'accept',
        content: { titled: 'internal', legacy: '', multi: ['a', 'b'] },
      }),
    ).toEqual({ titled: 'internal', legacy: '', multi: ['a', 'b'] });
    for (const multi of [[], ['unknown'], ['a', 'a']])
      expect(() =>
        validateElicitationResolution(request, {
          decision: 'accept',
          content: { titled: 'internal', legacy: '', multi },
        }),
      ).toThrow();
  });

  it.each([
    { count: '1', approved: false },
    { count: 1.5, approved: false },
    { count: Number.MAX_SAFE_INTEGER + 1, approved: false },
    { count: Infinity, approved: false },
    { count: 1, approved: 'false' },
    { count: 1, approved: false, extra: 'injected' },
  ])('rejects invalid typed content before acceptance: %j', (content) => {
    const request = form({ count: { type: 'integer' }, approved: { type: 'boolean' } }, [
      'count',
      'approved',
    ]);
    expect(() =>
      validateElicitationResolution(request, {
        decision: 'accept',
        content: content as Record<string, ElicitationValue>,
      }),
    ).toThrow();
  });

  it.each([
    { type: 'object', properties: { x: { type: 'string', pattern: '^secret' } } },
    { type: 'object', properties: { x: { type: 'number', multipleOf: 2 } } },
    { type: 'object', properties: { x: { type: 'object', properties: {} } } },
    { type: 'object', properties: {}, required: ['missing'] },
    { type: 'object', properties: {}, required: null },
    { type: 'object', properties: { x: { type: 'string' } }, required: ['x', 'x'] },
    { type: 'object', properties: {}, allOf: [] },
    { type: 'object', properties: { x: { type: 'string', format: 'password' } } },
    { type: 'object', properties: { x: { type: 'string', enum: ['a'], enumNames: ['a', 'b'] } } },
    { type: 'object', properties: { x: { type: 'number', minimum: 10, maximum: 1 } } },
  ])('keeps unsupported or malformed schemas actionable only for decline/cancel: %j', (schema) => {
    const request = {
      serverName: 'test',
      mode: 'form' as const,
      ...normalizeElicitationSchema(schema),
    };
    expect(request.schemaError).toBeTruthy();
    expect(() =>
      validateElicitationResolution(request, { decision: 'accept', content: {} }),
    ).toThrow();
    expect(validateElicitationResolution(request, { decision: 'decline' })).toBeNull();
    expect(validateElicitationResolution(request, { decision: 'cancel' })).toBeNull();
  });

  it.each(['form', 'openai/form', 'openaiForm'])(
    'normalizes %s with the same validation',
    (mode) => {
      const request = normalizeElicitationRequest({
        mode,
        serverName: 'test',
        requestedSchema: { type: 'object', properties: {} },
      });
      expect(request).toEqual({ mode: 'form', serverName: 'test', fields: [] });
    },
  );

  it.each([
    ['date', '2024-02-29', '2025-02-29'],
    ['date-time', '2024-02-29T15:30:01+08:00', '2025-02-29T15:30:01+08:00'],
    ['email', 'name@example.com', 'invalid email'],
    ['uri', 'https://example.com/path', 'relative/path'],
  ])('enforces %s formats on the server', (format, valid, invalid) => {
    const request = form({ value: { type: 'string', format } }, ['value']);
    expect(
      validateElicitationResolution(request, { decision: 'accept', content: { value: valid! } }),
    ).toEqual({ value: valid });
    expect(() =>
      validateElicitationResolution(request, { decision: 'accept', content: { value: invalid! } }),
    ).toThrow();
  });

  it('uses own-property semantics for supported inherited-looking JSON field names', () => {
    const request = form(
      JSON.parse('{"toString":{"type":"string"},"constructor":{"type":"boolean"}}') as Record<
        string,
        unknown
      >,
      ['toString', 'constructor'],
    );
    const content = JSON.parse('{"toString":"test","constructor":false}') as Record<
      string,
      string | boolean
    >;
    expect(validateElicitationResolution(request, { decision: 'accept', content })).toEqual(
      content,
    );
    expect(() =>
      validateElicitationResolution(request, { decision: 'accept', content: {} }),
    ).toThrow();
  });

  it('rejects __proto__ fields that the HTTP parser cannot preserve, even when optional', () => {
    for (const required of [[], ['__proto__']]) {
      const request = form(
        JSON.parse('{"__proto__":{"type":"string"}}') as Record<string, unknown>,
        required,
      );
      expect(request.schemaError).toContain('__proto__');
      expect(() =>
        validateElicitationResolution(request, { decision: 'accept', content: {} }),
      ).toThrow();
      expect(validateElicitationResolution(request, { decision: 'decline' })).toBeNull();
    }
  });

  it('does not allow decline/cancel to smuggle content or accept unknown modes', () => {
    const request = normalizeElicitationRequest({ mode: 'custom', serverName: 'test' });
    expect(request.schemaError).toBeTruthy();
    expect(() =>
      validateElicitationResolution(request, { decision: 'accept', content: {} }),
    ).toThrow();
    expect(() =>
      validateElicitationResolution(request, { decision: 'decline', content: {} }),
    ).toThrow();
    expect(validateElicitationResolution(request, { decision: 'decline' })).toBeNull();
  });
});

describe('URL elicitation and permission decisions', () => {
  it.each([
    'javascript:alert(1)',
    'file:///tmp/secret',
    '/relative',
    'https://user:secret@example.com',
  ])('disables unsafe URL %s', (url) => {
    const request = normalizeElicitationRequest({ mode: 'url', serverName: 'test', url });
    expect(request.schemaError).toBeTruthy();
    expect(request.url).toBe(url);
    expect(() => validateElicitationResolution(request, { decision: 'accept' })).toThrow();
    expect(validateElicitationResolution(request, { decision: 'cancel' })).toBeNull();
  });

  it('accepts an explicit URL completion with no content', () => {
    const request = normalizeElicitationRequest({
      mode: 'url',
      serverName: 'test',
      url: 'https://example.com/authorize',
    });
    expect(validateElicitationResolution(request, { decision: 'accept' })).toBeNull();
    expect(() =>
      validateElicitationResolution(request, { decision: 'accept', content: {} }),
    ).toThrow();
  });

  it('accepts only permission decisions, never a client-supplied grant', () => {
    for (const decision of ['accept', 'acceptForSession', 'decline'])
      expect(validatePermissionResolution({ decision })).toBe(decision);
    for (const resolution of [
      { decision: 'accept', permissions: { network: { enabled: true } } },
      { decision: 'accept', scope: 'session' },
      { decision: 'accept', content: {} },
      { decision: 'cancel' },
    ])
      expect(() => validatePermissionResolution(resolution as ActionResolution)).toThrow();
  });
});
