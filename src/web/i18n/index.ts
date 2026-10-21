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
  const formatted = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      value === undefined || value === null || value === false
        ? ''
        : typeof value === 'number' && name !== 'count'
          ? formatNumber(value)
          : value,
    ]),
  );
  if (!i18n.exists(key, formatted)) return String(i18n.t('common:requestFailed'));
  const translated = i18n.t(key, formatted);
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
    document.title = `Covro · ${t('workspace:workspace')}`;
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

// Store message identity with its values, so notices already on screen switch languages too.
const prefix = '\u0001covro-message:';
export function message(key: string, values: Record<string, unknown> = {}): string {
  return prefix + JSON.stringify({ key, values });
}
export function displayMessage(value: string): string;
export function displayMessage(value: string | undefined | null): string | undefined;
export function displayMessage(value: string | undefined | null): string | undefined {
  if (value == null) return undefined;
  if (!value.startsWith(prefix)) return value;
  try {
    const { key, values } = JSON.parse(value.slice(prefix.length)) as {
      key: string;
      values: Record<string, unknown>;
    };
    return t(
      key,
      Object.fromEntries(
        Object.entries(values).map(([name, item]) => [
          name,
          typeof item === 'string' ? displayMessage(item) : item,
        ]),
      ),
    );
  } catch {
    return t('common:requestFailed');
  }
}

/** Raw diagnostics are displayed separately from the translated application explanation. */
export function messageDetails(value: string | undefined): string | undefined {
  if (!value?.startsWith(prefix)) return undefined;
  try {
    const data = JSON.parse(value.slice(prefix.length)) as { values?: { details?: unknown } };
    return typeof data.values?.details === 'string' ? data.values.details : undefined;
  } catch {
    return undefined;
  }
}

export const formatList = (values: string[]) =>
  new Intl.ListFormat(currentLocale(), { style: 'short', type: 'conjunction' }).format(values);
