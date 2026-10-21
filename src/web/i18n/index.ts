import { createInstance, type Resource } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { resources } from './resources';
import {
  fallbackLocale,
  initialLocale,
  isLocale,
  LOCALE_STORAGE_KEY,
  saveLocale,
  supportedLocales,
  type Locale,
} from './locales';

export function createTranslator(locale: Locale, translations: Resource = resources) {
  const instance = createInstance().use(initReactI18next);
  // Resources ship with the app: language changes never suspend or remount the workspace.
  void instance.init({
    resources: translations,
    lng: locale,
    supportedLngs: [...supportedLocales],
    fallbackLng: fallbackLocale,
    defaultNS: 'common',
    load: 'currentOnly',
    initAsync: false,
    returnEmptyString: false,
    returnNull: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
}

export const i18n = createTranslator(initialLocale());

export function currentLocale(): Locale {
  return isLocale(i18n.resolvedLanguage) ? i18n.resolvedLanguage : fallbackLocale;
}

/** Only application-owned messages enter this function; conversation content stays untouched. */
export function t(key: string, values: Record<string, unknown> = {}): string {
  if (!i18n.exists(key, values)) return String(i18n.t('common:requestFailed'));
  const translated = i18n.t(key, values);
  return translated && translated !== key
    ? String(translated)
    : String(i18n.t('common:requestFailed'));
}

export function changeLocale(locale: Locale) {
  saveLocale(locale);
  return i18n.changeLanguage(locale);
}

export function useInterfaceLocale() {
  useTranslation(undefined, { i18n });
  const locale = currentLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY && isLocale(event.newValue))
        void i18n.changeLanguage(event.newValue);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return locale;
}

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(currentLocale(), options).format(value);

export const formatDate = (value: Date, options?: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(currentLocale(), options).format(value);
