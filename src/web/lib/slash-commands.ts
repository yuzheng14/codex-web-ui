import type { Operation, Project, Settings, SystemInfo, ThreadView } from '../../shared/types';
import { isActive } from '../components/Status';
import { compatibilityConfirmationRequired } from './compatibility';
import { blocksTarget, type SavedOperation } from './operations';
import type { ConnectionState } from './realtime';
import { readableError } from './utils';

export type SlashCommandName = 'help' | 'new' | 'fork' | 'resume' | 'stop' | 'status';

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
  run: () => Promise<SlashCommandResult>;
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
  if (parsed.arguments) return `/${command.name} 不接受参数。用法：${command.usage}`;
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
  projectSettings: Settings;
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
}

const definitions: { name: SlashCommandName; description: string }[] = [
  { name: 'help', description: '查看本网页支持的命令和使用方式' },
  { name: 'new', description: '在当前项目新建会话' },
  { name: 'fork', description: '复制当前会话已保存的历史为新会话' },
  { name: 'resume', description: '恢复当前选中的历史会话（不是 CLI 会话选择器）' },
  { name: 'stop', description: '请求中断当前任务（网页快捷命令）' },
  { name: 'status', description: '打开当前连接、运行状态与提交诊断' },
];

function unavailableReason(name: SlashCommandName, context: SlashCommandContext) {
  if (name === 'help' || name === 'status') return undefined;
  if (context.authRequired || context.connection === 'authenticationRequired')
    return '登录已过期，请重新登录后重试。';
  if (context.connection !== 'connected') return '当前已离线，请等待连接恢复后重试。';
  if (context.system?.authenticated === false) return 'Codex 尚未登录，请先完成认证。';
  if (!context.system?.ready) return 'Codex 尚不可用，请先查看状态诊断。';
  if (name !== 'stop' && compatibilityConfirmationRequired(context.system))
    return '请先确认当前 Codex 版本的兼容性提示。';
  const capability = {
    new: 'thread/start',
    fork: 'thread/fork',
    resume: 'thread/resume',
    stop: 'turn/interrupt',
  }[name];
  if (!context.system.capabilities.includes(capability))
    return `当前 Codex 未提供 ${capability} 能力。`;
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
    if (busy('create', context.project!.id)) return '正在新建会话，请等待回执。';
    if (unsettled(context.project!.id)) return '新建会话的请求尚未确认，请先用 /status 核对提交。';
    return undefined;
  }
  const thread = context.thread;
  if (!thread) return context.selectedId ? '会话正在加载，请稍后重试。' : '请先选择一个会话。';
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
  if (name === 'new' || name === 'fork') {
    const result = operation.result as
      { threadId?: unknown; id?: unknown; thread?: { id?: unknown } } | undefined;
    const id = result?.threadId ?? result?.thread?.id ?? (name === 'new' ? result?.id : undefined);
    if (typeof id !== 'string' || !id)
      return {
        error: true,
        message: '请求已被接受，但尚未获得新会话标识，请用 /status 核对提交。',
      };
    return { message: name === 'new' ? '已新建会话。' : '已 Fork 为新会话。', draftKey: id };
  }
  return {
    message: name === 'stop' ? '已提交中断请求，请等待任务状态更新。' : '已恢复当前选中的会话。',
  };
}

/** Menu availability and execution share guards; re-read state before each dispatch. */
export function createSlashCommands(getContext: () => SlashCommandContext): SlashCommand[] {
  const initial = getContext();
  return definitions.map(({ name, description }) => ({
    name,
    description,
    usage: `/${name}（无需参数）`,
    unavailableReason: unavailableReason(name, initial),
    run: async () => {
      const context = getContext();
      if (name === 'help')
        return {
          message: `${definitions.map((entry) => `/${entry.name}：${entry.description}`).join('\n')}\n所有命令均无需参数。输入 // 可发送以 / 开头的普通消息。`,
        };
      if (name === 'status') {
        context.openStatus();
        return { message: '已打开状态诊断；可在面板中刷新或核对提交。' };
      }
      if (context.project?.id !== initial.project?.id || context.selectedId !== initial.selectedId)
        return { error: true, message: '当前项目或会话已切换，请重新选择命令。' };
      const reason = unavailableReason(name, context);
      if (reason) return { error: true, message: reason };
      const thread = context.thread;
      const path = `/api/threads/${encodeURIComponent(thread?.id ?? '')}`;
      try {
        let operation: Operation | undefined;
        if (name === 'new') {
          const projectId = context.project!.id;
          operation = await context.run(
            'create',
            projectId,
            `/api/projects/${encodeURIComponent(projectId)}/threads`,
            {
              settings: context.projectSettings,
            },
          );
        } else if (name === 'fork') {
          operation = await context.run('fork', thread!.id, `${path}/fork`, {
            settings: context.settings,
          });
        } else if (name === 'resume') {
          context.onResumeAttempt();
          operation = await context.run('resume', thread!.id, `${path}/resume`);
          await context.refreshThread();
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
