import type { GatewayConfig } from '../../shared/gateway-config';

const MIB = 1024 * 1024;
const sizeRange = (maxMiB: number) => `0.0009765625–${maxMiB} MiB（最小 1 KiB）`;
function sizeField<Key extends string>(
  key: Key,
  label: string,
  maxMiB: number,
  defaultMiB: number,
) {
  return {
    key,
    label: `${label}（MiB）`,
    group: 'advanced',
    unit: 'MiB',
    maxMiB,
    help: `范围 ${sizeRange(maxMiB)}，默认 ${defaultMiB} MiB。支持精确对应整数字节的小数；1 MiB = 1024 × 1024 字节。`,
  } as const;
}

// A byte is exactly 2^-20 MiB. Keep all 20 decimal places before trimming zeros:
// Number.toString() can shorten the decimal and lose the exact byte value on parsing.
const bytesToMiB = (bytes: number) => (bytes / MIB).toFixed(20).replace(/\.?0+$/, '');

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
  sizeField('maxLineBytes', 'Codex 单行消息上限', 256, 64),
  sizeField('eventBytes', '事件缓冲上限', 64, 16),
  sizeField('wsBytes', 'WebSocket 缓冲上限', 16, 4),
  sizeField('itemBytes', '单项内容上限', 8, 2),
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
    maxLineBytes: bytesToMiB(config.codex.maxLineBytes),
    eventBytes: bytesToMiB(config.limits.eventBytes),
    wsBytes: bytesToMiB(config.limits.wsBytes),
    itemBytes: bytesToMiB(config.limits.itemBytes),
  };
}
const lines = (value: string) =>
  value
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
type SizeField = Extract<ConfigField, { unit: 'MiB' }>;
const sizeFields = configFields.filter((field): field is SizeField => 'unit' in field);
export type ConfigFormErrors = Partial<Record<ConfigField['key'], string>>;

function parseMiB(text: string, field: SizeField): { bytes: number; error?: string } {
  const invalid = (reason: string) => ({ bytes: NaN, error: `${field.label}：${reason}` });
  const value = text.trim();
  if (!value) return invalid('请输入 MiB 数值。');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)))
    return invalid('请输入有效的 MiB 数值，可使用小数。');
  if (Number(value) < 1 / 1024 || Number(value) > field.maxMiB)
    return invalid(`范围为 ${sizeRange(field.maxMiB)}。`);

  const [whole, decimal = ''] = value.replace(/^\+/, '').split('.');
  const fraction = decimal.replace(/0+$/, '');
  const fractionalByte = () =>
    invalid('MiB 数值必须精确对应整数字节，请调整小数（不会自动舍入）。');
  if (fraction.length > 20) return fractionalByte();
  const scale = 10n ** BigInt(fraction.length);
  const numerator = (BigInt(whole || '0') * scale + BigInt(fraction || '0')) * BigInt(MIB);
  if (numerator < 1024n * scale || numerator > BigInt(field.maxMiB * MIB) * scale)
    return invalid(`范围为 ${sizeRange(field.maxMiB)}。`);
  if (numerator % scale !== 0n) return fractionalByte();
  return { bytes: Number(numerator / scale) };
}

export function configFormErrors(form: ConfigForm): ConfigFormErrors {
  return Object.fromEntries(
    sizeFields.flatMap((field) => {
      const { error } = parseMiB(form[field.key], field);
      return error ? [[field.key, error]] : [];
    }),
  );
}

export function configFieldValue(field: ConfigField, value: string) {
  return 'unit' in field ? `${value} ${field.unit}` : value;
}

export function formConfig(form: ConfigForm, saved: GatewayConfig): GatewayConfig {
  const sizes = Object.fromEntries(
    sizeFields.map((field) => [field.key, parseMiB(form[field.key], field).bytes]),
  );
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
      maxLineBytes: sizes.maxLineBytes!,
    },
    limits: {
      eventBytes: sizes.eventBytes!,
      wsBytes: sizes.wsBytes!,
      itemBytes: sizes.itemBytes!,
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
      .map((field) => ({
        label: field.label,
        before: configFieldValue(field, a[field.key]),
        after: configFieldValue(field, b[field.key]),
      })),
  ];
}
