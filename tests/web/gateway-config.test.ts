import { describe, expect, it } from 'vitest';
import { parseFileConfig } from '../../src/server/config';
import {
  configChanges,
  configFields,
  configForm,
  configFormErrors,
  formConfig,
} from '../../src/web/lib/gateway-config';

const MIB = 1024 * 1024;
const defaults = parseFileConfig({});
const fields = [
  ['maxLineBytes', 64, 256],
  ['eventBytes', 16, 64],
  ['wsBytes', 4, 16],
  ['itemBytes', 2, 8],
] as const;

it('shows byte defaults, ranges and change summaries consistently in MiB', () => {
  const form = configForm(defaults);
  for (const [key, initial, max] of fields) {
    expect(form[key]).toBe(String(initial));
    const field = configFields.find((field) => field.key === key)!;
    expect(field.label).toContain('MiB');
    expect(field.help).toContain(`默认 ${initial} MiB`);
    expect(field.help).toContain(`0.0009765625–${max} MiB（最小 1 KiB）`);
    form[key] = '1.5';
  }
  expect(configFormErrors(form)).toEqual({});
  const config = formConfig(form, defaults);
  expect(parseFileConfig(config)).toEqual(config);
  expect(config.codex.maxLineBytes).toBe(1572864);
  expect(config.limits).toEqual({ eventBytes: 1572864, wsBytes: 1572864, itemBytes: 1572864 });
  expect(configChanges(defaults, config)).toEqual(
    fields.map(([key, initial]) => ({
      label: configFields.find((field) => field.key === key)!.label,
      before: `${initial} MiB`,
      after: '1.5 MiB',
    })),
  );
});

for (const [key, , max] of fields) {
  describe(key, () => {
    it('round-trips every significant boundary without changing a byte', () => {
      for (const bytes of [1024, 1025, 65537, MIB - 1, MIB + 1, max * MIB - 1, max * MIB]) {
        const saved = structuredClone(defaults);
        if (key === 'maxLineBytes') saved.codex.maxLineBytes = bytes;
        else saved.limits[key] = bytes;
        const form = configForm(saved);
        expect(configFormErrors(form)).toEqual({});
        expect(formConfig(form, saved)).toEqual(saved);
        expect(configChanges(saved, formConfig(form, saved))).toEqual([]);
        form.requestTimeoutMs = '18000';
        const edited = formConfig(form, saved);
        expect(key === 'maxLineBytes' ? edited.codex[key] : edited.limits[key]).toBe(bytes);
        expect(parseFileConfig(edited)).toEqual(edited);
      }
    });

    it('accepts integer and exact decimal MiB including the original byte boundaries', () => {
      for (const [text, bytes] of [
        ['1', MIB],
        ['1.5', 1572864],
        ['.5', MIB / 2],
        ['+1.2500', 1310720],
        [' 2 ', 2 * MIB],
        ['0.0009765625', 1024],
        ['1.00000095367431640625', MIB + 1],
        [String(max), max * MIB],
      ] as const) {
        const form = { ...configForm(defaults), [key]: text };
        expect(configFormErrors(form)).toEqual({});
        const config = formConfig(form, defaults);
        expect(key === 'maxLineBytes' ? config.codex[key] : config.limits[key]).toBe(bytes);
        expect(parseFileConfig(config)).toEqual(config);
      }
    });

    it('rejects empty, invalid, out-of-range and fractional-byte values with units', () => {
      for (const [text, reason] of [
        ['', '请输入'],
        ['   ', '请输入'],
        ['abc', '有效'],
        ['NaN', '有效'],
        ['Infinity', '有效'],
        ['1,5', '有效'],
        ['0x10', '有效'],
        ['0', '范围'],
        ['-1', '范围'],
        ['0.00097560882568359375', '范围'],
        [String(max + 1), '范围'],
        ['0.1', '整数字节'],
        ['1.00000000000000001', '整数字节'],
        ['1.000000000000000000001', '整数字节'],
      ]) {
        const form = { ...configForm(defaults), [key]: text! };
        const error = configFormErrors(form)[key];
        expect(error).toContain('MiB');
        expect(error).toContain(reason);
        const config = formConfig(form, defaults);
        expect(key === 'maxLineBytes' ? config.codex[key] : config.limits[key]).toBeNaN();
      }
    });
  });
}

it('round-trips optional workDir without creating unsaved edits and supports clearing it', () => {
  const saved = parseFileConfig({ workDir: '/workspace/projects' });
  const form = configForm(saved);
  expect(form.workDir).toBe('/workspace/projects');
  expect(JSON.stringify(formConfig(form, saved))).toBe(JSON.stringify(saved));
  form.requestTimeoutMs = '18000';
  expect(formConfig(form, saved).workDir).toBe('/workspace/projects');
  form.workDir = '  ';
  const cleared = formConfig(form, saved);
  expect(JSON.parse(JSON.stringify(cleared))).not.toHaveProperty('workDir');
  expect(parseFileConfig(cleared).workDir).toBeUndefined();
  expect(configChanges(saved, cleared)).toContainEqual({
    label: '项目基础目录（workDir，可选）',
    before: '/workspace/projects',
    after: '',
  });
});
