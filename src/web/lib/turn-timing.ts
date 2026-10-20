import { t, currentLocale } from '../i18n';
const unit = (value: number, name: string) =>
  currentLocale() === 'zh-Hans'
    ? t(`conversation:${{ hour: 'hours', minute: 'min', second: 'sec' }[name]}`, { v0: value })
    : new Intl.NumberFormat(currentLocale(), {
        style: 'unit',
        unit: name,
        unitDisplay: 'short',
      }).format(value);

export function formatTurnDuration(durationMs?: number): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs > 0 && durationMs < 1000) return t('conversation:less_than_1_second');
  const seconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [
    ...(hours ? [unit(hours, 'hour')] : []),
    ...(minutes ? [unit(minutes, 'minute')] : []),
    ...(seconds % 60 || seconds === 0 ? [unit(seconds % 60, 'second')] : []),
  ].join(' ');
}

/** Use the browser's time zone, including the UTC offset at completion (not today's offset). */
export function formatTurnCompletedAt(completedAt?: number, timeZone?: string) {
  if (completedAt === undefined || !Number.isFinite(completedAt) || completedAt < 0)
    return undefined;
  const date = new Date(completedAt);
  if (!Number.isFinite(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat(currentLocale(), {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)!.value;
  return {
    dateTime: date.toISOString(),
    label:
      currentLocale() === 'zh-Hans'
        ? `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}（${part('timeZoneName').replace(/^GMT$/, 'GMT+00:00').replace('GMT', 'UTC')}）`
        : parts
            .map((part) =>
              part.type === 'timeZoneName'
                ? part.value.replace(/^GMT$/, 'GMT+00:00').replace('GMT', 'UTC')
                : part.value,
            )
            .join(''),
  };
}
