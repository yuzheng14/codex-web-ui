export const supportedLocales = ['zh-Hans', 'en', 'ja', 'ko'] as const;
export type Locale = (typeof supportedLocales)[number];

export const localeNames: Record<Locale, string> = {
  'zh-Hans': '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
};

export const LOCALE_STORAGE_KEY = 'covro.locale';
export const fallbackLocale: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return supportedLocales.includes(value as Locale);
}

/** Negotiate BCP 47 preferences without treating Traditional Chinese as Simplified. */
export function matchLocale(preference: string): Locale | undefined {
  try {
    const locale = new Intl.Locale(preference);
    switch (locale.language) {
      case 'en':
      case 'ja':
      case 'ko':
        return locale.language;
      case 'zh':
        // An explicit script takes precedence over the region (e.g. zh-Hans-TW).
        return locale.maximize().script === 'Hans' ? 'zh-Hans' : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

export function resolveLocale(preferences: readonly string[], saved?: unknown): Locale {
  if (isLocale(saved)) return saved;
  for (const preference of preferences) {
    const locale = matchLocale(preference);
    if (locale) return locale;
  }
  return fallbackLocale;
}

export function initialLocale(): Locale {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Private browsing and storage policies must not prevent using the app.
  }
  return resolveLocale(
    typeof navigator === 'undefined'
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language],
    saved,
  );
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The choice still applies to the current page when persistence is unavailable.
  }
}
