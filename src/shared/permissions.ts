import type { PermissionCapabilities, PermissionMode } from './types.js';

/** Verified against Codex 0.163.0's built-in profiles and permissions menu. */
export const permissionModes = {
  ask: {
    label: '请求批准',
    description: '可在项目内读写和运行命令，联网或越界操作由你批准。',
    profile: ':workspace',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalReviewer: 'user',
  },
  'auto-review': {
    label: '帮我批准',
    description: '与请求批准的权限相同，符合条件的申请由自动审核处理。',
    profile: ':workspace',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalReviewer: 'auto_review',
  },
  'full-access': {
    label: '完全访问',
    description: '可访问项目外文件和网络，无 Codex 沙箱限制，无需审批。',
    profile: ':danger-full-access',
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    approvalReviewer: 'user',
  },
  'read-only': {
    label: '只读',
    description: '可读取文件，写入或联网需要你批准。',
    profile: ':read-only',
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    approvalReviewer: 'user',
  },
} as const;

export function permissionModeUnavailable(
  mode: PermissionMode,
  capabilities?: PermissionCapabilities,
  model?: string | null,
): string | undefined {
  if (!capabilities) return '尚未读取权限模式的可用条件';
  if (capabilities.unavailableReason) return capabilities.unavailableReason;
  const preset = permissionModes[mode];
  if (capabilities.allowedProfiles && !capabilities.allowedProfiles.includes(preset.profile))
    return '受管要求不允许此权限 profile';
  if (
    capabilities.allowedSandboxModes &&
    !capabilities.allowedSandboxModes.includes(preset.sandbox)
  )
    return '受管要求不允许此权限范围';
  if (
    capabilities.allowedApprovalPolicies &&
    !capabilities.allowedApprovalPolicies.includes(preset.approvalPolicy)
  )
    return '受管要求不允许此审批策略';
  return permissionReviewerUnavailable(preset.approvalReviewer, capabilities, model);
}

export function permissionReviewerUnavailable(
  reviewer: 'user' | 'auto_review',
  capabilities?: PermissionCapabilities,
  model?: string | null,
): string | undefined {
  if (!capabilities) return '尚未读取审核方的可用条件';
  if (capabilities.unavailableReason) return capabilities.unavailableReason;
  if (capabilities.allowedReviewers && !capabilities.allowedReviewers.includes(reviewer))
    return '受管要求不允许此审核方';
  if (reviewer === 'auto_review' && !capabilities.autoReview)
    return '当前 Codex 未启用自动审核（guardian_approval）';
  if (model && capabilities.autoReviewRequiredModels.includes(model) && reviewer !== 'auto_review')
    return '受管要求规定此模型必须使用自动审核';
  return undefined;
}
