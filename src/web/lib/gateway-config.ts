import type { GatewayConfig } from '../../shared/gateway-config';

export const configFields = [
  {
    key: 'host',
    label: '监听地址',
    group: 'network',
    help: '本机模式使用 127.0.0.1、localhost 或 ::1。',
  },
  {
    key: 'port',
    label: '监听端口',
    group: 'network',
    type: 'number',
    help: '范围 1–65535；修改后使用新端口访问。',
  },
  {
    key: 'publicOrigin',
    label: '允许访问地址',
    group: 'network',
    multiline: true,
    help: '每行一个完整的 HTTP(S) 地址，仅包含协议、主机和端口。',
  },
  {
    key: 'issuer',
    label: 'Access 团队地址',
    group: 'network',
    help: '例如 https://your-team.cloudflareaccess.com',
  },
  {
    key: 'audience',
    label: 'Access 应用 AUD',
    group: 'network',
    help: '填写 Cloudflare Access 应用的 Audience。',
  },
  {
    key: 'binary',
    label: 'Codex 可执行文件',
    group: 'codex',
    help: '可填写 codex 或服务器上的绝对路径。',
  },
  {
    key: 'home',
    label: 'CODEX_HOME（可选）',
    group: 'codex',
    help: '留空继承服务进程环境；指定时必须填写服务器上的绝对路径。',
  },
  {
    key: 'requestTimeoutMs',
    label: '请求超时（毫秒）',
    group: 'codex',
    type: 'number',
    help: '范围 100–300000，默认 30000。',
  },
  {
    key: 'maxLineBytes',
    label: 'Codex 单行消息上限（字节）',
    group: 'advanced',
    type: 'number',
    help: '范围 1024–268435456，默认 67108864。',
  },
  {
    key: 'eventBytes',
    label: '事件缓冲上限（字节）',
    group: 'advanced',
    type: 'number',
    help: '范围 1024–67108864，默认 16777216。',
  },
  {
    key: 'wsBytes',
    label: 'WebSocket 缓冲上限（字节）',
    group: 'advanced',
    type: 'number',
    help: '范围 1024–16777216，默认 4194304。',
  },
  {
    key: 'itemBytes',
    label: '单项内容上限（字节）',
    group: 'advanced',
    type: 'number',
    help: '范围 1024–8388608，默认 2097152。',
  },
  {
    key: 'developmentOrigins',
    label: '开发环境来源',
    group: 'advanced',
    multiline: true,
    help: '每行一个本机 HTTP(S) 来源，仅在 --dev 模式使用。',
  },
] as const;
export type ConfigField = (typeof configFields)[number];
export type ConfigForm = Record<ConfigField['key'], string> & {
  mode: GatewayConfig['auth']['mode'];
};

export function configForm(config: GatewayConfig): ConfigForm {
  return {
    host: config.host,
    port: String(config.port),
    publicOrigin: config.publicOrigin.join('\n'),
    developmentOrigins: config.developmentOrigins.join('\n'),
    mode: config.auth.mode,
    issuer: config.auth.mode === 'cloudflare-access' ? config.auth.issuer : '',
    audience: config.auth.mode === 'cloudflare-access' ? config.auth.audience : '',
    binary: config.codex.binary,
    home: config.codex.home ?? '',
    requestTimeoutMs: String(config.codex.requestTimeoutMs),
    maxLineBytes: String(config.codex.maxLineBytes),
    eventBytes: String(config.limits.eventBytes),
    wsBytes: String(config.limits.wsBytes),
    itemBytes: String(config.limits.itemBytes),
  };
}
const lines = (value: string) =>
  value
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
export function formConfig(form: ConfigForm, saved: GatewayConfig): GatewayConfig {
  return {
    ...saved,
    host: form.host.trim(),
    port: Number(form.port),
    publicOrigin: lines(form.publicOrigin),
    developmentOrigins: lines(form.developmentOrigins),
    auth:
      form.mode === 'local'
        ? { mode: 'local' }
        : { mode: form.mode, issuer: form.issuer.trim(), audience: form.audience.trim() },
    codex: {
      binary: form.binary.trim(),
      ...(form.home.trim() ? { home: form.home.trim() } : {}),
      requestTimeoutMs: Number(form.requestTimeoutMs),
      maxLineBytes: Number(form.maxLineBytes),
    },
    limits: {
      eventBytes: Number(form.eventBytes),
      wsBytes: Number(form.wsBytes),
      itemBytes: Number(form.itemBytes),
    },
  };
}
export function configChanges(before: GatewayConfig, after: GatewayConfig) {
  const a = configForm(before),
    b = configForm(after);
  return [
    ...(a.mode === b.mode ? [] : [{ label: '认证模式', before: a.mode, after: b.mode }]),
    ...configFields
      .filter(
        (field) =>
          !(['issuer', 'audience'].includes(field.key) && b.mode === 'local') &&
          a[field.key] !== b[field.key],
      )
      .map((field) => ({ label: field.label, before: a[field.key], after: b[field.key] })),
  ];
}
