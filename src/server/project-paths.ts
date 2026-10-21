import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { AppError } from '../shared/errors.js';

export function assertWorkDir(path: string): void {
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory');
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch {
    throw new AppError(
      'WORK_DIR_UNAVAILABLE',
      'workDir 目录不存在、不是目录或不可访问；请检查服务主机上的目录和权限，或填写其他绝对路径。',
      409,
    );
  }
}

/** Resolve on the host so browser previews use the same path rules as registration. */
export function resolveProjectPath(path: string, workDir?: string): string {
  if (!path || path.includes('\0'))
    throw new AppError('INVALID_PROJECT_PATH', '请填写服务器上的项目目录', 400);
  if (isAbsolute(path)) return resolve(path);
  if (!workDir)
    throw new AppError('INVALID_PROJECT_PATH', '未配置 workDir，请填写服务器上的绝对目录路径', 400);
  assertWorkDir(workDir);
  return resolve(workDir, path);
}

export function projectPathPreview(path: string, workDir?: string, directory?: string) {
  const input = path || (directory === undefined ? workDir : workDir && directory);
  if (!input) {
    if (workDir) assertWorkDir(workDir);
    return { workDir, path: '' };
  }
  if (!path && workDir) assertWorkDir(workDir);
  return { workDir, path: resolveProjectPath(input, workDir) };
}
