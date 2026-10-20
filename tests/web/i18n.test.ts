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
        const english = resources.en[namespace as keyof typeof resources.en];
        const translated = resources[locale][namespace as keyof typeof resources.en];
        expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort());
        for (const key of Object.keys(english) as (keyof typeof english)[]) {
          expect(translated[key].trim(), `${locale}:${namespace}:${key}`).not.toBe('');
          expect(parameters(translated[key])).toEqual(parameters(english[key]));
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
