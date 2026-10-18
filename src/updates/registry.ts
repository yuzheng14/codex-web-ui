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
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function validVersion(version: string) {
  const match = versionPattern.exec(version);
  return Boolean(
    match &&
    (!match[4] ||
      match[4]
        .split('.')
        .every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'))),
  );
}
export function compareVersions(left: string, right: string): number {
  if (!validVersion(left) || !validVersion(right)) throw new Error('Invalid release version');
  const a = versionPattern.exec(left)!;
  const b = versionPattern.exec(right)!;
  for (let i = 1; i <= 3; i++) {
    const difference = BigInt(a[i]!) - BigInt(b[i]!);
    if (difference) return difference > 0 ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const ap = a[4].split('.');
  const bp = b[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
export const releaseSchema = z.object({
  name: z.literal('covro'),
  version: z.string().refine(validVersion),
  gitHead: z.string().optional(),
});
export async function lookupRelease(channel: ReleaseChannel, signal?: AbortSignal) {
  // Resolve a channel exactly once. Install the resulting immutable version, never the moving tag.
  const response = await fetch(`${registry}/covro/${npmTags[channel]}`, {
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
  const expected = join(await realpath(globalRoot), 'covro');
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
