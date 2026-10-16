import type { ItemView, RunStatus, ThreadView } from '../shared/types.js';

export interface ThreadExport {
  filename: string;
  markdown: string;
  partial: boolean;
}

const statuses: Record<RunStatus, string> = {
  idle: '空闲',
  running: '运行中',
  waitingApproval: '等待审批',
  waitingInput: '等待输入',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  unknown: '未知',
};
const unfinished = (status: RunStatus) =>
  ['running', 'waitingApproval', 'waitingInput', 'unknown'].includes(status);
const line = (value: string) =>
  Array.from(value, (character) =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character,
  ).join('');

/** Keep tool output literal even when it contains Markdown fences. */
function code(value: string, language = 'text') {
  let longest = 2;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${value}\n${fence}`;
}

function renderItem(item: ItemView): string {
  const parts: string[] = [];
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    parts.push(`### ${item.type === 'userMessage' ? '用户' : '助手'}`, item.text ?? '');
    const count = Math.max(item.imageCount ?? 0, item.images?.length ?? 0);
    if (count) parts.push(`> [${count} 张图片未嵌入导出文件；图片内容、地址和本地路径均已省略。]`);
  } else if (item.type === 'commandExecution') {
    parts.push('### 工具：命令执行');
    if (item.command) parts.push(code(item.command, 'sh'));
    if (item.output) parts.push(code(item.output));
    else parts.push('> [没有已保存的工具输出。]');
    if (item.status) parts.push(`状态：${line(item.status)}`);
    if (item.error) parts.push(code(item.error));
  } else if (item.type === 'fileChange') {
    parts.push('### 工具：文件变更');
    for (const change of item.changes ?? [])
      parts.push(code(`${change.kind}: ${change.path}`), code(change.diff, 'diff'));
    if (item.status) parts.push(`状态：${line(item.status)}`);
  } else if (item.type === 'plan') {
    parts.push('### 计划', item.text ?? '');
  } else if (item.type === 'exitedReviewMode') {
    parts.push('### 代码审查结果', item.text || '> [没有已保存的审查结果正文。]');
  } else if (item.type === 'enteredReviewMode') {
    parts.push('### 会话事件', '进入代码审查模式。');
  } else if (item.type === 'contextCompaction') {
    parts.push('### 会话事件', '记录了上下文压缩事件；压缩后的内部上下文不导出。');
  } else {
    // Raw tool details, approval payloads and reasoning are not a portable conversation format.
    // An allowlist prevents private transport metadata from silently entering a downloadable file.
    parts.push(`### 记录：${line(item.type)}`, '> [此类记录的内部内容未导出。]');
  }
  if (item.truncated) parts.push('> [内容已截断：上游仅保留了部分内容，不能视为完整输出。]');
  return parts.filter((part) => part !== '').join('\n\n');
}

/** Called only with a fresh, fully paginated history, never a browser/stream snapshot. */
export function renderThreadExport(
  thread: ThreadView,
  options: { exportedAt?: Date; executionUncertain?: boolean; historyChanged?: boolean } = {},
): ThreadExport {
  const partial = Boolean(
    thread.historyTruncated ||
    unfinished(thread.status) ||
    options.executionUncertain ||
    options.historyChanged ||
    thread.turns.some(
      (turn) => unfinished(turn.status) || turn.items.some((item) => item.truncated),
    ),
  );
  const parts = [
    `# ${line(thread.title) || 'Codex 会话'}`,
    `会话：${line(thread.id)}  \n导出时间：${(options.exportedAt ?? new Date()).toISOString()}  \n会话状态：${statuses[thread.status]}`,
    '> 导出范围：本次读取到的已保存会话历史快照（非原子读取）。已遍历 Codex 返回的全部历史分页，只包含接口仍保留的内容，不包括尚未持久化的增量。',
    '> 图片仅记录数量；命令、工具文本输出和文件差异按已保存内容导出。推理、未知类型的内部内容、审批数据和运行配置不导出。',
  ];
  if (partial)
    parts.push(
      '> **此快照不是完整的最终结果：存在未完成、状态待确认、读取期间变化或已截断的内容。**',
    );
  if (thread.historyTruncated) parts.push('> [会话历史已截断，可能缺少轮次。]');
  if (options.executionUncertain) parts.push('> [服务仍有未结束或待核对的执行记录。]');
  if (options.historyChanged)
    parts.push('> [读取期间会话发生变化；本文件只表示本次已读到的历史。]');
  if (!thread.turns.length) parts.push('此会话尚无已保存的轮次。');
  for (const [index, turn] of thread.turns.entries()) {
    parts.push(`## 第 ${index + 1} 轮 · ${statuses[turn.status]}`);
    if (unfinished(turn.status)) parts.push('> [此轮尚未完成或状态未确认，后续内容可能未保存。]');
    for (const item of turn.items) parts.push(renderItem(item));
    if (turn.error) parts.push('本轮错误：', code(turn.error));
    if (turn.diff) parts.push('### 本轮文件差异', code(turn.diff, 'diff'));
  }
  const safeId = thread.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'session';
  return {
    filename: `codex-thread-${safeId}-history${partial ? '-partial' : ''}.md`,
    markdown: `${parts.join('\n\n')}\n`,
    partial,
  };
}
