import type { PendingAction } from '../../shared/types';

export function actionStatusLabel(status: PendingAction['status']): string {
  switch (status) {
    case 'pending':
      return '需要你处理';
    case 'responding':
      return '正在提交…';
    case 'responded':
      return '已处理';
    case 'expired':
      return '请求已失效';
  }
}
