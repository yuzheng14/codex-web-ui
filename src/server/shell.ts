import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { CodexClient } from '../codex/types.js';
import { CodexError } from '../codex/transport.js';
import { AppError } from '../shared/errors.js';
import {
  shellActive,
  SHELL_OUTPUT_BYTES,
  type ShellCommand,
  type StartShellInput,
} from '../shared/shell.js';
import type { Project } from '../shared/types.js';

/** Bounded, server-owned runs. Browser navigation never owns a process lifetime. */
export class ShellService {
  private readonly epoch = randomUUID();
  private revision = 0;
  private readonly commands = new Map<string, ShellCommand>();
  constructor(private readonly codex: CodexClient) {}

  snapshot(epoch?: string, after = 0) {
    return {
      epoch: this.epoch,
      revision: this.revision,
      commands: [...this.commands.values()].filter(
        (run) => epoch !== this.epoch || run.revision > after,
      ),
    };
  }
  active(projectId?: string) {
    return [...this.commands.values()].some(
      (run) => shellActive(run) && (!projectId || run.projectId === projectId),
    );
  }
  private changed(run: ShellCommand) {
    run.revision = ++this.revision;
  }

  start(project: Project, input: StartShellInput): ShellCommand {
    if (this.active(project.id))
      throw new AppError('SHELL_BUSY', '此项目已有命令运行，请先中断或等待结束', 409);
    if ([...this.commands.values()].filter(shellActive).length >= 4)
      throw new AppError('SHELL_BUSY', '最多同时运行 4 个项目的命令', 409);
    if (!this.codex.executeCommand || !this.codex.terminateCommand)
      throw new AppError('PROTOCOL_INCOMPATIBLE', '当前 Codex 不支持 Shell 命令执行', 409);
    const run: ShellCommand = {
      id: input.clientOperationId,
      projectId: project.id,
      projectName: project.name,
      cwd: project.canonicalRoot,
      command: input.command,
      status: 'running',
      startedAt: Date.now(),
      output: [],
      truncated: false,
      revision: 0,
    };
    this.commands.set(run.id, run);
    this.changed(run);
    while (this.commands.size > 20) {
      const oldest = [...this.commands.values()].find((entry) => !shellActive(entry));
      if (!oldest) break;
      this.commands.delete(oldest.id);
    }
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const append = (stream: 'stdout' | 'stderr', text: string) => {
      if (!text) return;
      const last = run.output.at(-1);
      if (last?.stream === stream) last.text += text;
      else run.output.push({ stream, text });
      // Bound both bytes and chunk count even for alternating single-byte writes.
      let size = run.output.reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0);
      while (run.output.length > 200 || size > SHELL_OUTPUT_BYTES) {
        run.truncated = true;
        const first = run.output[0]!;
        const bytes = Buffer.byteLength(first.text);
        if (run.output.length > 1) {
          run.output.shift();
          size -= bytes;
        } else {
          const buffer = Buffer.from(first.text);
          let start = size - SHELL_OUTPUT_BYTES;
          // Start on a complete code point; replacement bytes can otherwise exceed the cap.
          while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
          first.text = buffer.subarray(start).toString('utf8');
          break;
        }
      }
      this.changed(run);
    };
    void this.codex
      .executeCommand(run.id, run.cwd, run.command, (stream, bytes, capReached) => {
        append(stream, decoders[stream].write(bytes));
        if (capReached) {
          run.truncated = true;
          this.changed(run);
        }
      })
      .then((result) => {
        append('stdout', decoders.stdout.end() + result.stdout);
        append('stderr', decoders.stderr.end() + result.stderr);
        run.exitCode = result.exitCode;
        run.status =
          run.status === 'stopping'
            ? 'interrupted'
            : result.exitCode === 0
              ? 'completed'
              : 'failed';
      })
      .catch((error: unknown) => {
        append('stdout', decoders.stdout.end());
        append('stderr', decoders.stderr.end());
        run.status = error instanceof CodexError && error.uncertain ? 'unknown' : 'failed';
        run.error = error instanceof Error ? error.message : '命令执行失败';
        if (run.status === 'unknown') run.error += '；执行结果未知，请检查服务端，勿直接重复执行。';
      })
      .finally(() => {
        run.finishedAt = Date.now();
        this.changed(run);
      });
    return structuredClone(run);
  }
  async interrupt(id: string) {
    const run = this.commands.get(id);
    if (!run) throw new AppError('SHELL_NOT_FOUND', '命令记录已过期或服务已重启', 404);
    if (!shellActive(run)) return;
    run.status = 'stopping';
    this.changed(run);
    try {
      await this.codex.terminateCommand!(id);
    } catch (error) {
      if (run.status === 'stopping') {
        run.status = 'running';
        run.error = '中断请求未确认，请重试或检查服务端。';
        this.changed(run);
      }
      throw error;
    }
  }
}
