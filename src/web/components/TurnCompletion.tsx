import type { TurnView } from '../../shared/types';
import { formatTurnCompletedAt, formatTurnDuration } from '../lib/turn-timing';
import { formatTurnTps } from '../lib/turn-tps';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Icon } from './Icon';

export function TurnCompletion({ turn }: { turn: TurnView }) {
  if (turn.status !== 'completed') return null;
  const duration = formatTurnDuration(turn.durationMs);
  const completed = formatTurnCompletedAt(turn.completedAt);
  const tps = formatTurnTps(turn.outputTokens, turn.durationMs);
  return (
    <div className="turn-completion" role="group" aria-label="本轮完成信息">
      <span className="turn-completion-status">
        <Icon name="check" size={14} />
        已完成
      </span>
      <span> · {duration ? `耗时 ${duration}` : '耗时未知'}</span>
      <span>
        {' · '}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="turn-tps" tabIndex={0}>
                {tps === undefined ? 'TPS 未知' : `平均 ${tps} TPS`}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {tps === undefined
                ? '缺少完整的本轮 token 统计或有效耗时，无法计算 TPS。'
                : `本轮输出 ${turn.outputTokens} tokens ÷ 总耗时（秒）。包含推理 token、工具执行和等待时间，不代表纯模型生成速度。`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
      <span>
        {' · '}
        {completed ? (
          <>
            完成于 <time dateTime={completed.dateTime}>{completed.label}</time>
          </>
        ) : (
          '完成时间未知'
        )}
      </span>
    </div>
  );
}
