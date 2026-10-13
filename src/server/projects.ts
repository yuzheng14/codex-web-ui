import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AppError } from '../shared/errors.js';
import type { Project } from '../shared/types.js';

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
}

export function containsPath(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function checkoutRoot(cwd: string): string | undefined {
  try {
    const output = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output ? realpathSync(output) : undefined;
  } catch {
    return undefined;
  }
}

export class ProjectRegistry {
  constructor(private readonly registered: ProjectConfig[]) {}

  private inspect(config: ProjectConfig): Project {
    const rootPath = resolve(config.path);
    try {
      const canonicalRoot = realpathSync(rootPath);
      if (!statSync(canonicalRoot).isDirectory()) throw new Error('注册路径不是目录');
      return {
        id: config.id,
        name: config.name,
        rootPath,
        canonicalRoot,
        workspaceKey: checkoutRoot(canonicalRoot) ?? canonicalRoot,
        available: true,
      };
    } catch (error) {
      return {
        id: config.id,
        name: config.name,
        rootPath,
        canonicalRoot: rootPath,
        workspaceKey: rootPath,
        available: false,
        error: error instanceof Error ? error.message : '项目不可用',
      };
    }
  }

  list(): Project[] {
    return this.registered.map((project) => this.inspect(project));
  }

  get(id: string): Project {
    const config = this.registered.find((project) => project.id === id);
    if (!config) throw new AppError('PROJECT_NOT_FOUND', '项目未注册', 404);
    const project = this.inspect(config);
    if (!project.available)
      throw new AppError('PROJECT_UNAVAILABLE', '项目目录不可用', 409, { projectId: id });
    return project;
  }

  assertOwnership(
    projectId: string,
    cwd: string,
  ): { project: Project; cwd: string; workspaceKey: string } {
    const project = this.get(projectId);
    let canonicalCwd: string;
    try {
      canonicalCwd = realpathSync(cwd);
      if (!statSync(canonicalCwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new AppError('PROJECT_UNAVAILABLE', '会话工作目录不可用', 409);
    }
    if (!containsPath(project.canonicalRoot, canonicalCwd))
      throw new AppError('PROJECT_OWNERSHIP', '会话不属于所选项目目录', 403);
    return {
      project,
      cwd: canonicalCwd,
      workspaceKey: checkoutRoot(canonicalCwd) ?? project.canonicalRoot,
    };
  }

  findOwner(cwd: string): { project: Project; cwd: string; workspaceKey: string } {
    let canonicalCwd: string;
    try {
      canonicalCwd = realpathSync(cwd);
    } catch {
      throw new AppError('PROJECT_UNAVAILABLE', '会话目录不可用', 409);
    }
    const project = this.list()
      .filter((entry) => entry.available && containsPath(entry.canonicalRoot, canonicalCwd))
      .sort((a, b) => b.canonicalRoot.length - a.canonicalRoot.length)[0];
    if (!project) throw new AppError('PROJECT_OWNERSHIP', '会话不属于已注册项目', 403);
    return this.assertOwnership(project.id, canonicalCwd);
  }
}
