import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function probe(command: string, args: string[]) {
  try {
    const result = await exec(command, args, { timeout: 4000, maxBuffer: 64 * 1024 });
    return { exitCode: 0, ...result, failure: undefined };
  } catch (error) {
    const result = error as {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    return {
      exitCode: typeof result.code === 'number' ? result.code : null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      failure: result.killed
        ? 'timeout'
        : typeof result.code === 'string'
          ? result.code
          : undefined,
    };
  }
}

export async function launchContext() {
  const manager =
    process.platform === 'darwin' ? await probe('/bin/launchctl', ['managername']) : undefined;
  return {
    platform: process.platform,
    manager:
      manager?.exitCode === 0 &&
      /^(Aqua|Background|System|LoginWindow|StandardIO)$/.test(manager.stdout.trim())
        ? manager.stdout.trim()
        : null,
    uid: process.getuid?.() ?? null,
  };
}

/** Runs inside the daemon. Return classifications only: command errors can contain credentials. */
export async function doctor() {
  const context = await launchContext();
  const environmentToken = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
  const credential = await probe('gh', ['auth', 'token', '--hostname', 'github.com']);
  const found = credential.exitCode === 0 && Boolean(credential.stdout.trim());
  const credentialSource = environmentToken ? 'environment' : 'stored';
  const notes = [
    '检查来自运行中的 Covro 实例，不是调用 doctor 的终端。',
    '未探测 Agent 或 Shell 的 Codex 沙箱；实例认证成功不代表受限命令具有相同权限。',
  ];
  if (context.platform === 'darwin' && context.manager && context.manager !== 'Aqua')
    notes.push(
      '实例不在 Aqua 桌面会话，系统钥匙串可能不可访问；在桌面登录后用 covro stop 和 covro start 重启，或安装 GUI 登录服务。',
    );
  if (environmentToken)
    notes.push('GH_TOKEN 或 GITHUB_TOKEN 已设置，GitHub CLI 会优先使用环境变量中的凭证。');
  const base = {
    pid: process.pid,
    launchContext: context,
    scope: 'daemon-child-process',
    sandbox: 'not-tested',
    credentialSource,
    credentialReadable: found,
  };
  if (credential.failure === 'ENOENT')
    return {
      ...base,
      result: 'gh-unavailable',
      notes: [...notes, '实例 PATH 中没有 GitHub CLI。'],
    };
  if (!found)
    return {
      ...base,
      result: 'credential-unavailable',
      lookupExitCode: credential.exitCode,
      notes: [
        ...notes,
        '未能读取凭证，尚未验证令牌是否有效；请分别检查启动会话、钥匙串/沙箱访问和是否已配置凭证，不能据此认定需要重新登录。',
      ],
    };
  const api = await probe('gh', [
    'api',
    'user',
    '--hostname',
    'github.com',
    '--include',
    '--silent',
  ]);
  const status = /HTTP\/[\d.]+\s+(\d{3})/.exec(`${api.stdout}\n${api.stderr}`)?.[1];
  const httpStatus = status ? Number(status) : null;
  const result =
    api.exitCode === 0
      ? 'authenticated'
      : httpStatus === 401
        ? 'authentication-rejected'
        : httpStatus === 403
          ? 'request-forbidden'
          : 'request-failed';
  if (result === 'authentication-rejected')
    notes.push(
      '已读取凭证，但 GitHub 返回 401；请检查撤销、失效或环境变量覆盖，而不是将其归因于钥匙串读取失败。',
    );
  else if (result === 'request-forbidden')
    notes.push('GitHub 返回 403；请检查权限、组织策略或请求限额，不能据此认定令牌失效。');
  else if (result === 'request-failed')
    notes.push('已读取凭证，但认证请求未成功；请检查网络、代理或服务状态，未确认令牌失效。');
  return { ...base, result, httpStatus, requestExitCode: api.exitCode, notes };
}
