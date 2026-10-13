import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(value: number | string) {
  const date = typeof value === 'number' && value < 1e12 ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function readableError(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}
