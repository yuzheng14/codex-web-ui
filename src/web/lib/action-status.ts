import { t } from '../i18n';
import type { PendingAction } from '../../shared/types';

export function actionStatusLabel(status: PendingAction['status']): string {
  switch (status) {
    case 'pending':
      return t('approvals:action_required');
    case 'responding':
      return t('common:submitting');
    case 'responded':
      return t('approvals:handled');
    case 'expired':
      return t('approvals:request_expired');
  }
}
