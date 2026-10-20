import { describe, expect, it } from 'vitest';
import { matchLocale, resolveLocale } from '../../src/web/i18n/locales';

describe('interface locale negotiation', () => {
  it.each([
    ['zh', 'zh-Hans'],
    ['zh-CN', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'],
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hans-TW', 'zh-Hans'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['ja-JP', 'ja'],
    ['ko-KR', 'ko'],
  ])('matches %s to %s', (preference, expected) => {
    expect(matchLocale(preference)).toBe(expected);
  });

  it.each(['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-CN', 'fr', '', 'en_US'])(
    'does not falsely match %s',
    (preference) => expect(matchLocale(preference)).toBeUndefined(),
  );

  it('uses the first supported browser preference and otherwise English', () => {
    expect(resolveLocale(['zh-TW', 'ja-JP', 'en-US'])).toBe('ja');
    expect(resolveLocale(['fr-FR', 'zh-Hant'])).toBe('en');
    expect(resolveLocale([])).toBe('en');
  });

  it('prioritizes a supported manual choice and ignores invalid saved values', () => {
    expect(resolveLocale(['ja-JP'], 'ko')).toBe('ko');
    expect(resolveLocale(['ja-JP'], 'zh-Hant')).toBe('ja');
    expect(resolveLocale(['ko-KR'], '<script>')).toBe('ko');
  });
});
