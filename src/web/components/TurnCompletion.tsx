import type { TurnView } from '../../shared/types';
import { formatTurnCompletedAt, formatTurnDuration } from '../lib/turn-timing';
import { Icon } from './Icon';

export function TurnCompletion({ turn }: { turn: TurnView }) {
  if (turn.status !== 'completed') return null;
  const duration = formatTurnDuration(turn.durationMs);
  const completed = formatTurnCompletedAt(turn.completedAt);
  return (
    <div className="turn-completion" role="group" aria-label="本轮完成信息">
      <span className="turn-completion-status">
        <Icon name="check" size={14} />
        已完成
      </span>
      <span> · {duration ? `耗时 ${duration}` : '耗时未知'}</span>
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
