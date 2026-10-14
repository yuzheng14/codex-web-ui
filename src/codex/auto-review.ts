import type { AutoReviewView } from '../shared/types.js';
import type { GuardianApprovalReviewAction } from './generated/v2/GuardianApprovalReviewAction.js';
import type { FileSystemPath } from './generated/v2/FileSystemPath.js';
import type { ItemGuardianApprovalReviewStartedNotification } from './generated/v2/ItemGuardianApprovalReviewStartedNotification.js';
import type { ItemGuardianApprovalReviewCompletedNotification } from './generated/v2/ItemGuardianApprovalReviewCompletedNotification.js';

type Notification =
  ItemGuardianApprovalReviewStartedNotification | ItemGuardianApprovalReviewCompletedNotification;

function pathLabel(path: FileSystemPath): string {
  if (path.type === 'path') return path.path;
  if (path.type === 'glob_pattern') return `匹配：${path.pattern}`;
  const special = path.value;
  const subpath =
    'subpath' in special && special.subpath !== null ? `（子路径：${special.subpath}）` : '';
  switch (special.kind) {
    case 'root':
      return '整个文件系统（/）';
    case 'minimal':
      return '系统基础运行目录';
    case 'project_roots':
      return `项目根目录${subpath}`;
    case 'tmpdir':
      return '系统临时目录（TMPDIR）';
    case 'slash_tmp':
      return '/tmp';
    case 'unknown':
      return `特殊路径：${special.path}${subpath}`;
  }
}

function describeAction(
  action: GuardianApprovalReviewAction,
): Pick<AutoReviewView, 'actionLabel' | 'actionSummary' | 'cwd'> {
  switch (action.type) {
    case 'command':
      return { actionLabel: '命令执行', actionSummary: action.command, cwd: action.cwd };
    case 'execve':
      return {
        actionLabel: '程序执行',
        actionSummary: `程序：${action.program}\n参数：${action.argv.map((arg) => JSON.stringify(arg)).join(' ')}`,
        cwd: action.cwd,
      };
    case 'writeStdin':
      return {
        actionLabel: '终端输入',
        actionSummary: `进程 ${action.processId}\n${action.stdin}`,
        cwd: action.cwd,
      };
    case 'applyPatch':
      return {
        actionLabel: '文件变更',
        actionSummary: action.files.join('\n') || '未提供文件路径',
        cwd: action.cwd,
      };
    case 'networkAccess':
      return {
        actionLabel: '网络访问',
        actionSummary: `${action.protocol}://${action.host}:${action.port}\n${action.target}`,
      };
    case 'mcpToolCall':
      return {
        actionLabel: '工具调用',
        actionSummary: [
          action.connectorName,
          `${action.server}/${action.toolName}`,
          action.toolTitle,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'requestPermissions': {
      const lines: string[] = [];
      if (action.reason) lines.push(action.reason);
      if (
        action.permissions.network?.enabled !== null &&
        action.permissions.network?.enabled !== undefined
      )
        lines.push(`网络访问：${action.permissions.network.enabled ? '允许' : '不开放额外权限'}`);
      const files = action.permissions.fileSystem;
      if (files) {
        for (const path of files.read ?? []) lines.push(`读取：${path}`);
        for (const path of files.write ?? []) lines.push(`写入：${path}`);
        for (const entry of files.entries ?? [])
          lines.push(
            `${{ read: '读取', write: '写入', deny: '禁止访问' }[entry.access]}：${pathLabel(entry.path)}`,
          );
        if (files.globScanMaxDepth !== undefined)
          lines.push(`目录匹配搜索深度：${files.globScanMaxDepth}`);
      }
      return {
        actionLabel: '权限变更',
        actionSummary: lines.join('\n') || '未请求额外网络或文件访问权限',
      };
    }
    default:
      return { actionLabel: '操作审核', actionSummary: '未提供可识别的操作详情' };
  }
}

/** Display-only data. Notifications never become a PendingAction or a permission response. */
export function mapAutoReview(params: Notification): AutoReviewView {
  const review = params.review;
  return {
    reviewId: params.reviewId,
    ...(params.targetItemId === null ? {} : { targetItemId: params.targetItemId }),
    status: ['inProgress', 'approved', 'denied', 'timedOut', 'aborted'].includes(review.status)
      ? review.status
      : 'unknown',
    ...describeAction(params.action),
    ...(review.rationale === null ? {} : { rationale: review.rationale }),
    ...(review.riskLevel === null ? {} : { riskLevel: review.riskLevel }),
    ...(review.userAuthorization === null ? {} : { userAuthorization: review.userAuthorization }),
    startedAtMs: params.startedAtMs,
    ...('completedAtMs' in params ? { completedAtMs: params.completedAtMs } : {}),
  };
}
