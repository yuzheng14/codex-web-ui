import { z } from 'zod';

export const startShellSchema = z
  .object({
    clientOperationId: z.string().uuid(),
    command: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => Boolean(value.trim()) && !value.includes('\0')),
  })
  .strict();
export type StartShellInput = z.infer<typeof startShellSchema>;
export type ShellStatus =
  'running' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export interface ShellCommand {
  id: string;
  projectId: string;
  projectName: string;
  cwd: string;
  command: string;
  status: ShellStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  output: { stream: 'stdout' | 'stderr'; text: string }[];
  truncated: boolean;
  error?: string;
  revision: number;
}
export interface ShellSnapshot {
  epoch: string;
  revision: number;
  commands: ShellCommand[];
}
export const shellActive = (command: Pick<ShellCommand, 'status'>) =>
  command.status === 'running' || command.status === 'stopping';
export const SHELL_TIMEOUT_MS = 10 * 60 * 1000;
export const SHELL_OUTPUT_BYTES = 64 * 1024;
