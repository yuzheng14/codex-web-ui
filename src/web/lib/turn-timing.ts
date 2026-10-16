export function formatTurnDuration(durationMs?: number): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs > 0 && durationMs < 1000) return '不足 1 秒';
  const seconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [
    ...(hours ? [`${hours} 小时`] : []),
    ...(minutes ? [`${minutes} 分`] : []),
    ...(seconds % 60 || seconds === 0 ? [`${seconds % 60} 秒`] : []),
  ].join(' ');
}

/** Use the browser's time zone, including the UTC offset at completion (not today's offset). */
export function formatTurnCompletedAt(completedAt?: number, timeZone?: string) {
  if (completedAt === undefined || !Number.isFinite(completedAt) || completedAt < 0)
    return undefined;
  const date = new Date(completedAt);
  if (!Number.isFinite(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
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
    label: `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}（${part('timeZoneName').replace(/^GMT$/, 'GMT+00:00').replace('GMT', 'UTC')}）`,
  };
}
