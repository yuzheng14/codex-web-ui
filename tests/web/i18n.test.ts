import { describe, expect, it } from 'vitest';
import { createTranslator, i18n, t } from '../../src/web/i18n';
import { resources } from '../../src/web/i18n/resources';
import { supportedLocales } from '../../src/web/i18n/locales';

const parameters = (value: string) =>
  [...value.matchAll(/{{\s*([^},\s]+).*?}}/g)].map((m) => m[1]).sort();

describe('interface translations', () => {
  it.each(supportedLocales)(
    '%s has all English keys and matching interpolation parameters',
    (locale) => {
      for (const namespace of Object.keys(resources.en)) {
        const english: Record<string, string> =
          resources.en[namespace as keyof typeof resources.en];
        const translated: Record<string, string> =
          resources[locale][namespace as keyof typeof resources.en];
        expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort());
        for (const key of Object.keys(english) as (keyof typeof english)[]) {
          expect(translated[key]!.trim(), `${locale}:${namespace}:${key}`).not.toBe('');
          expect(parameters(translated[key]!)).toEqual(parameters(english[key]!));
        }
      }
    },
  );

  it('falls back to English for missing or empty translations', () => {
    const translator = createTranslator('ja', {
      en: { common: { missing: 'English fallback', blank: 'Nonempty fallback' } },
      ja: { common: { blank: '' } },
    });
    expect(translator.t('missing')).toBe('English fallback');
    expect(translator.t('blank')).toBe('Nonempty fallback');
    expect(t('unknown:missing')).toBe(i18n.t('common:requestFailed'));
  });

  it('supports interpolation and language-aware plurals', () => {
    const translator = createTranslator('en', {
      en: {
        common: {
          items_one: '{{count}} activity for {{name}}',
          items_other: '{{count}} activities for {{name}}',
        },
      },
    });
    expect(translator.t('items', { count: 1, name: 'Alice' })).toBe('1 activity for Alice');
    expect(translator.t('items', { count: 3, name: 'Alice' })).toBe('3 activities for Alice');
  });
});

it('every literal application message key exists in the English catalog', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const ts = await import('typescript');
  const root = new URL('../../src/web/', import.meta.url);
  async function check(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'i18n') await check(new URL(entry.name + '/', directory));
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const file = new URL(entry.name, directory);
      const source = ts.createSourceFile(
        entry.name,
        await readFile(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        entry.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const catalog: Record<string, Record<string, string>> = resources.en;
      function visit(node: import('typescript').Node) {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ['t', 'message'].includes(node.expression.text) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const key = node.arguments[0].text;
          const [namespace, name] = key.split(':');
          expect(catalog[namespace!]?.[name!], `${file.pathname}: ${key}`).toBeTypeOf('string');
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  await check(root);
});

it('retains message identity and uses the selected language for stored notices and API errors', async () => {
  const { i18n, t, formatNumber } = await import('../../src/web/i18n');
  const { message, displayMessage } = await import('../../src/web/i18n/messages');
  const { HttpError } = await import('../../src/web/lib/api');
  const { readableError } = await import('../../src/web/lib/utils');
  const original = { code: 'THREAD_IN_USE', message: '原始诊断 /work/例子.ts' };
  const stored = readableError(new HttpError(409, original));
  const notice = message('common:copied', {});
  const { configFields } = await import('../../src/web/lib/gateway-config');
  const size = configFields.find((field) => field.key === 'wsBytes')!;
  await i18n.changeLanguage('en');
  expect(displayMessage(stored)).toContain('another process');
  expect(size.label).toBe('WebSocket buffer limit (MiB)');
  expect(size.help).toContain('default 4 MiB');
  expect(original.message).toBe('原始诊断 /work/例子.ts');
  expect(t('conversation:activities', { v0: 1, count: 1 })).toBe('1 activity');
  expect(t('conversation:activities', { v0: 1234, count: 1234 })).toBe('1,234 activities');
  expect(formatNumber(1234)).toBe('1,234');
  expect(t('unknown:missing')).toBe('Request failed. Please try again.');
  await i18n.changeLanguage('ja');
  expect(displayMessage(stored)).toContain('別のプロセス');
  expect(size.label).toBe('WebSocket バッファー上限（MiB）');
  expect(size.help).toContain('既定 4 MiB');
  expect(displayMessage(notice)).not.toContain('settings:');
  await i18n.changeLanguage('zh-Hans');
});
