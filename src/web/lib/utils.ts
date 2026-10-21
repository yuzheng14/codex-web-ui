import { HttpError } from './api';
import { errorMessage } from './error-message';
import { t, currentLocale } from '../i18n';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(value: number | string) {
  const date = typeof value === 'number' && value < 1e12 ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat(currentLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function readableError(error: unknown) {
  return error instanceof HttpError
    ? errorMessage(error.problem)
    : error instanceof Error
      ? error.message
      : t('workspace:request_failed_please_try_again');
}
