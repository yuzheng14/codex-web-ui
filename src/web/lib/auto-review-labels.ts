import type { AutoReviewView } from '../../shared/types';
import { resources } from '../i18n/resources';
import { t } from '../i18n';

const kinds = [
  'command',
  'execve',
  'writeStdin',
  'applyPatch',
  'networkAccess',
  'mcpToolCall',
  'requestPermissions',
] as const;
export function reviewLabel(review: AutoReviewView): string {
  const kind =
    review.presentation?.kind ??
    kinds.find((kind) => resources['zh-Hans'].approvals[kind] === review.actionLabel);
  return kind && kinds.includes(kind as (typeof kinds)[number])
    ? t(`approvals:${kind}`)
    : t('approvals:unknownAction');
}
export function reviewSummary(review: AutoReviewView): string {
  if (!review.presentation) return review.actionSummary;
  return review.presentation.parts
    .map((part) =>
      part.label === 'raw'
        ? part.value
        : part.value
          ? t('approvals:fieldValue', {
              label: t(`approvals:${part.label === 'deny' ? 'accessDeny' : part.label}`),
              value: part.value,
            })
          : t(`approvals:${part.label === 'deny' ? 'accessDeny' : part.label}`),
    )
    .join('\n');
}
