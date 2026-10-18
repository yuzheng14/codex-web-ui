import type { Operation, Project, Settings, SystemInfo, ThreadView } from '../../shared/types';
import { threadNameError } from '../../shared/thread-name';
import { isActive } from '../components/Status';
import { compatibilityConfirmationRequired } from './compatibility';
import { blocksTarget, type SavedOperation } from './operations';
import type { ConnectionState } from './realtime';
import { readableError } from './utils';

export type SlashCommandName =
  | 'help'
  | 'new'
  | 'fork'
  | 'resume'
  | 'stop'
  | 'status'
  | 'compact'
  | 'review'
  | 'rename'
  | 'export';

export interface SlashCommandResult {
  message: string;
  error?: boolean;
  draftKey?: string;
}

export interface SlashCommand {
  name: SlashCommandName;
  description: string;
  usage: string;
  unavailableReason?: string;
  run: (argumentsText?: string) => Promise<SlashCommandResult>;
}

/** A double slash escapes command mode; the composer removes one slash when sending. */
export function parseSlashCommand(text: string): { name: string; arguments: string } | null {
  const input = text.trimStart();
  if (!input.startsWith('/') || input.startsWith('//')) return null;
  const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(input)!;
  return { name: match[1]!.toLowerCase(), arguments: (match[2] ?? '').trim() };
}

export function filterSlashCommands(commands: SlashCommand[], input: string): SlashCommand[] {
  const parsed = parseSlashCommand(input);
  if (!parsed) return [];
  if (parsed.arguments) return commands.filter((command) => command.name === parsed.name);
  const rank = (command: SlashCommand) =>
    command.name === parsed.name ? 0 : command.name.startsWith(parsed.name) ? 1 : 2;
  return commands
    .filter(
      (command) =>
        command.name.includes(parsed.name) ||
        command.description.toLowerCase().includes(parsed.name),
    )
    .sort((a, b) => rank(a) - rank(b));
}

export function validateSlashCommand(input: string, commands: SlashCommand[]): string | undefined {
  const parsed = parseSlashCommand(input);
  if (!parsed) return undefined;
  const command = commands.find((entry) => entry.name === parsed.name);
  if (!command)
    return parsed.name
      ? `未知命令 /${parsed.name}。使用 /help 查看可用命令；发送以 / 开头的普通消息请使用 //。`
      : '请选择命令，或输入 /help 查看可用命令。';
  if (command.name === 'rename') {
    const problem = threadNameError(parsed.arguments);
    if (problem) return problem;
  } else if (parsed.arguments) return `/${command.name} 不接受参数。用法：${command.usage}`;
  return command.unavailableReason;
}

export interface SlashCommandContext {
  project?: Project;
  selectedId?: string;
  thread?: ThreadView;
  system?: SystemInfo;
  connection: ConnectionState;
  authRequired: boolean;
  settings: Settings;
  openDraft: () => string;
  busy: string[];
  operations: SavedOperation[];
  run: (
    kind: string,
    target: string,
    path: string,
    body?: object,
  ) => Promise<Operation | undefined>;
  onResumeAttempt: () => void;
  refreshThread: () => Promise<unknown>;
  openStatus: () => void;
  exportThread: (threadId: string) => Promise<{ partial: boolean }>;
}

const definitions: { name: SlashCommandName; description: string }[] = [
  { name: 'help', description: '查看本网页支持的命令和使用方式' },
  { name: 'new', description: '打开当前项目的新建会话输入页' },
  { name: 'fork', description: '复制当前会话已保存的历史为新会话' },
  { name: 'resume', description: '恢复当前选中的历史会话（不是 CLI 会话选择器）' },
  { name: 'review', description: '审查当前项目的未提交改动（使用会话当前配置）' },
  { name: 'rename', description: '重命名当前会话，名称可包含空格' },
  { name: 'stop', description: '请求中断当前任务（网页快捷命令）' },
  { name: 'status', description: '打开当前连接、运行状态与提交诊断' },
  { name: 'compact', description: '压缩当前会话上下文，保留会话继续工作' },
  { name: 'export', description: '下载当前会话的已保存记录为 Markdown 文件' },
];

function unavailableReason(name: SlashCommandName, context: SlashCommandContext) {
  if (name === 'help' || name === 'status') return undefined;
  if (context.authRequired || context.connection === 'authenticationRequired')
    return '登录已过期，请重新登录后重试。';
  if (context.connection !== 'connected') return '当前已离线，请等待连接恢复后重试。';
  if (context.system?.authenticated === false) return 'Codex 尚未登录，请先完成认证。';
  if (!context.system?.ready) return 'Codex 尚不可用，请先查看状态诊断。';
  if (name === 'export') {
    if (!context.thread)
      return context.selectedId ? '会话正在加载，请稍后重试。' : '请先选择一个会话。';
    if (!context.system.capabilities.includes('thread/read'))
      return '当前 Codex 未提供 thread/read 能力。';
    return undefined;
  }
  if (name !== 'stop' && compatibilityConfirmationRequired(context.system))
    return '请先确认当前 Codex 版本的兼容性提示。';
  const capabilities = {
    fork: 'thread/fork',
    resume: 'thread/resume',
    review: 'review/start',
    rename: 'thread/name/set',
    stop: 'turn/interrupt',
    compact: 'thread/compact/start',
  };
  if (name !== 'new' && !context.system.capabilities.includes(capabilities[name]))
    return `当前 Codex 未提供 ${capabilities[name]} 能力。`;
  const busy = (kind: string, target: string) => context.busy.includes(`${kind}:${target}`);
  const unsettled = (target: string, kind?: string) =>
    context.operations.some(
      (entry) => (!kind || entry.kind === kind) && blocksTarget(entry, target),
    );
  if (name !== 'stop') {
    if (!context.project) return '请先选择一个项目。';
    if (!context.project.available) return '当前项目目录不可用，请先检查项目配置。';
  }
  if (name === 'new') {
    if (context.busy.some((entry) => entry.startsWith('saveModelDefaults:')))
      return '正在保存模型默认值，请完成后再操作。';
    if (busy('create', context.project!.id)) return '正在新建会话，请等待回执。';
    if (unsettled(context.project!.id)) return '新建会话的请求尚未确认，请先用 /status 核对提交。';
    return undefined;
  }
  const thread = context.thread;
  if (!thread) return context.selectedId ? '会话正在加载，请稍后重试。' : '请先选择一个会话。';
  if (name === 'compact') {
    if (thread.archived) return '请先取消归档后再压缩上下文。';
    if (!thread.managed) return '请先恢复当前会话，再压缩上下文。';
    if (!thread.turns.length) return '当前会话为空，无需压缩上下文。';
    if (busy('compact', thread.id)) return '压缩请求正在提交，请等待回执。';
    if (isActive(thread.status) || thread.turns.some((turn) => isActive(turn.status)))
      return '请等待当前任务结束后再压缩上下文。';
    if (
      thread.status === 'unknown' ||
      (thread.execution && !thread.execution.ended) ||
      unsettled(thread.id)
    )
      return '当前会话仍有待核对的执行，请先用 /status 核对提交。';
    return undefined;
  }
  if (name === 'review') {
    if (thread.archived) return '会话已归档，请先取消归档。';
    if (!thread.managed) return '会话尚未恢复，请先恢复后开始代码审查。';
    if (busy('review', thread.id)) return '正在提交代码审查，请等待回执。';
    if (unsettled(thread.id) || thread.status === 'unknown')
      return '当前会话有尚未确认的请求，请先用 /status 核对提交。';
    if (isActive(thread.status) || thread.turns.some((turn) => isActive(turn.status)))
      return '当前会话仍在运行，请等待任务结束后开始代码审查。';
    if (thread.execution && !thread.execution.ended)
      return '当前会话仍有执行占用，请先用 /status 核对旧任务。';
    return undefined;
  }
  if (name === 'rename') {
    if (thread.archived) return '请先取消归档并恢复会话后再重命名。';
    if (!thread.managed) return '请先恢复当前会话后再重命名；不能修改其他进程占用的会话。';
    if (busy('rename', thread.id)) return '正在重命名，请等待回执。';
    if (unsettled(thread.id, 'rename')) return '重命名请求尚未确认，请先用 /status 核对提交。';
    if (busy('archive', thread.id) || unsettled(thread.id, 'archive'))
      return '会话归档操作尚未确认，请先用 /status 核对提交。';
    return undefined;
  }
  if (name === 'fork') {
    if (!thread.turns.length) return '当前会话为空，发送首条消息后才能 Fork 已保存的历史。';
    if (busy('fork', thread.id)) return '正在 Fork 会话，请等待回执。';
    if (unsettled(thread.id, 'fork')) return 'Fork 请求尚未确认，请先用 /status 核对提交。';
    return undefined;
  }
  if (name === 'resume') {
    if (busy('resume', thread.id)) return '正在恢复会话，请等待回执。';
    if (unsettled(thread.id)) return '当前会话有尚未确认的请求，请先用 /status 核对提交。';
    if (
      thread.managed &&
      (thread.turns.some((turn) => isActive(turn.status)) || isActive(thread.status))
    )
      return '当前会话仍在运行，请等待任务结束或使用 /stop。';
    if (thread.execution && !thread.execution.ended)
      return '当前会话仍有执行占用，请先用 /status 核对旧任务。';
    if (thread.managed) return '当前会话已恢复，无需再次恢复。';
    // A previous writer conflict is retryable: Codex checks whether the owner has since released it.
    return undefined;
  }
  if (!thread.managed)
    return thread.resumeError?.code === 'THREAD_IN_USE'
      ? '当前会话被其他进程占用，无法从网页中断该进程的任务。'
      : '当前会话尚未恢复，无法从网页中断其他进程的任务。';
  if (busy('interrupt', thread.id)) return '中断请求正在提交，请等待回执。';
  if (unsettled(thread.id, 'interrupt')) return '中断请求尚未确认，请先用 /status 核对提交。';
  if (!thread.turns.some((turn) => isActive(turn.status)))
    return thread.status === 'unknown' || (thread.execution && !thread.execution.ended)
      ? '任务状态尚未确认，请先用 /status 核对提交。'
      : '当前会话没有可中断的任务。';
  return undefined;
}

function operationResult(name: SlashCommandName, operation?: Operation): SlashCommandResult {
  if (!operation)
    return {
      error: true,
      message: '未收到可确认的成功回执。请查看页面错误或用 /status 核对提交；输入已保留。',
    };
  if (operation.status === 'failed')
    return { error: true, message: operation.error?.message ?? '操作失败，请查看状态诊断。' };
  if (operation.status !== 'acknowledged')
    return { error: true, message: '提交结果尚未确认，请先用 /status 核对提交，不要重复提交。' };
  if (name === 'compact')
    return { message: '已提交上下文压缩请求；进度和结果以会话中的任务状态为准。' };
  if (name === 'rename') {
    const result = operation.result as { name?: unknown } | undefined;
    return typeof result?.name === 'string' && result.name
      ? { message: `会话已重命名为「${result.name}」。` }
      : { error: true, message: '重命名已被接受，但无法确认名称，请用 /status 核对提交。' };
  }
  if (name === 'fork') {
    const result = operation.result as
      { threadId?: unknown; id?: unknown; thread?: { id?: unknown } } | undefined;
    const id = result?.threadId ?? result?.thread?.id;
    if (typeof id !== 'string' || !id)
      return {
        error: true,
        message: '请求已被接受，但尚未获得新会话标识，请用 /status 核对提交。',
      };
    return { message: '已 Fork 为新会话。', draftKey: id };
  }
  return {
    message:
      name === 'review'
        ? '已提交代码审查，请在当前会话查看进度和结果。'
        : name === 'stop'
          ? '已提交中断请求，请等待任务状态更新。'
          : '已恢复当前选中的会话。',
  };
}

/** Menu availability and execution share guards; re-read state before each dispatch. */
export function createSlashCommands(getContext: () => SlashCommandContext): SlashCommand[] {
  const initial = getContext();
  return definitions.map(({ name, description }) => ({
    name,
    description,
    usage: name === 'rename' ? '/rename <名称>' : `/${name}（无需参数）`,
    unavailableReason: unavailableReason(name, initial),
    run: async (argumentsText = '') => {
      const context = getContext();
      if (name === 'help')
        return {
          message: `${definitions.map((entry) => `/${entry.name}${entry.name === 'rename' ? ' <名称>' : ''}：${entry.description}`).join('\n')}\n/rename 必须提供名称，其他命令无需参数。输入 // 可发送以 / 开头的普通消息。`,
        };
      if (name === 'status') {
        context.openStatus();
        return { message: '已打开状态诊断；可在面板中刷新或核对提交。' };
      }
      if (context.project?.id !== initial.project?.id || context.selectedId !== initial.selectedId)
        return { error: true, message: '当前项目或会话已切换，请重新选择命令。' };
      const reason = unavailableReason(name, context);
      if (reason) return { error: true, message: reason };
      if (name === 'rename') {
        const problem = threadNameError(argumentsText);
        if (problem) return { error: true, message: problem };
      }
      const thread = context.thread;
      const path = `/api/threads/${encodeURIComponent(thread?.id ?? '')}`;
      try {
        if (name === 'export') {
          const { partial } = await context.exportThread(thread!.id);
          return {
            message: partial
              ? '已发起 Markdown 下载；存在未完成、状态待确认或截断内容，请查看文件内说明。'
              : '已发起已保存历史的 Markdown 下载。图片和内部记录的省略范围已在文件中说明。',
          };
        }
        let operation: Operation | undefined;
        if (name === 'new') {
          return {
            draftKey: context.openDraft(),
            message: '已打开新会话输入页，发送首条消息时创建会话。',
          };
        } else if (name === 'fork') {
          operation = await context.run('fork', thread!.id, `${path}/fork`, {
            settings: context.settings,
          });
        } else if (name === 'review') {
          operation = await context.run('review', thread!.id, `${path}/review`);
        } else if (name === 'rename') {
          operation = await context.run('rename', thread!.id, `${path}/rename`, {
            name: argumentsText.trim(),
          });
        } else if (name === 'resume') {
          context.onResumeAttempt();
          operation = await context.run('resume', thread!.id, `${path}/resume`);
          await context.refreshThread();
        } else if (name === 'compact') {
          operation = await context.run('compact', thread!.id, `${path}/compact`);
        } else {
          const turn = thread!.turns.findLast((entry) => isActive(entry.status))!;
          operation = await context.run('interrupt', thread!.id, `${path}/interrupt`, {
            expectedTurnId: turn.id,
          });
        }
        return operationResult(name, operation);
      } catch (error) {
        return { error: true, message: readableError(error) };
      }
    },
  }));
}
