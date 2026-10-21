import { formatNumber } from '../i18n';
/** End-to-end turn throughput, including tool execution and waiting time. */
export function formatTurnTps(outputTokens?: number, durationMs?: number): string | undefined {
  if (
    outputTokens === undefined ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  )
    return undefined;
  const tps = outputTokens / (durationMs / 1000);
  if (!Number.isFinite(tps)) return undefined;
  const options = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  return tps > 0 && tps < 0.1 ? `<${formatNumber(0.1, options)}` : formatNumber(tps, options);
}
