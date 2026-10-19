import { npmPackageName } from '../shared/package.js';
import { validVersion } from '../shared/versions.js';
export { validVersion, compareVersions } from '../shared/versions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ReleaseChannel } from '../shared/updates.js';

const run = promisify(execFile);
export const registry = 'https://registry.npmjs.org';
export const npmTags: Record<ReleaseChannel, string> = {
  stable: 'latest',
  beta: 'beta',
  dev: 'dev',
};
export const releaseSchema = z.object({
  name: z.literal(npmPackageName),
  version: z.string().refine(validVersion),
  gitHead: z.string().optional(),
  covroCodex: z.unknown().optional(),
});
export function packageMetadataUrl(selector?: string) {
  const url = `${registry}/${encodeURIComponent(npmPackageName)}`;
  return selector === undefined ? url : `${url}/${encodeURIComponent(selector)}`;
}
export async function lookupRelease(channel: ReleaseChannel, signal?: AbortSignal) {
  // Resolve a channel exactly once. Install the resulting immutable version, never the moving tag.
  const response = await fetch(packageMetadataUrl(npmTags[channel]), {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? `npm 尚未发布 Covro 的 ${channel} 渠道`
        : `npm 查询失败（${response.status}）`,
    );
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error('npm 元数据过大');
  return releaseSchema.parse(JSON.parse(body));
}
export async function inspectInstallation(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('npm', ['root', '--global'], { timeout: 15_000 });
    return await inspectPackageDirectory(root, stdout.trim());
  } catch {
    return '无法确认可写的 npm 全局安装；请检查 npm、安装目录权限及后台 PATH。';
  }
}

export async function inspectPackageDirectory(root: string, globalRoot: string) {
  const expected = join(await realpath(globalRoot), npmPackageName);
  // npm link and pnpm global point outside the package directory. Following
  // that link would let the worker rename a developer's source checkout.
  if ((await lstat(expected)).isSymbolicLink() || (await realpath(root)) !== expected)
    return '当前为源码、链接或非 npm 全局安装；请使用原部署方式更新。';
  try {
    await lstat(join(expected, '.git'));
    return '当前安装包含 Git 工作区；请使用原部署方式更新。';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await access(root, constants.W_OK);
  return undefined;
}
