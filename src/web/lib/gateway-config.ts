import { t } from '../i18n';
import type { GatewayConfig } from '../../shared/gateway-config';

const MIB = 1024 * 1024;
const sizeRange = (maxMiB: number) => t('settings:0_0009765625_mib_minimum_1_kib', { v0: maxMiB });
function sizeField<Key extends string>(
  key: Key,
  labelKey: string,
  maxMiB: number,
  defaultMiB: number,
) {
  return {
    key,
    get label() {
      return t('settings:fieldUnit', { label: t(labelKey) });
    },
    group: 'advanced',
    unit: 'MiB',
    maxMiB,
    get help() {
      return t('settings:range_default_mib_decimals_must_correspond_to_whole', {
        v0: sizeRange(maxMiB),
        v1: defaultMiB,
      });
    },
  } as const;
}

// A byte is exactly 2^-20 MiB. Keep all 20 decimal places before trimming zeros:
// Number.toString() can shorten the decimal and lose the exact byte value on parsing.
const bytesToMiB = (bytes: number) => (bytes / MIB).toFixed(20).replace(/\.?0+$/, '');

export const configFields = [
  {
    key: 'host',
    get label() {
      return t('settings:listen_address');
    },
    group: 'network',
    get help() {
      return t('settings:use_127_0_0_1_localhost_or_1');
    },
  },
  {
    key: 'port',
    get label() {
      return t('settings:listen_port');
    },
    group: 'network',
    type: 'number',
    get help() {
      return t('settings:range_1_65535_use_the_new_port_after');
    },
  },
  {
    key: 'publicOrigin',
    get label() {
      return t('settings:allowed_origins');
    },
    group: 'network',
    multiline: true,
    get help() {
      return t('settings:one_complete_http_s_origin_per_line_scheme');
    },
  },
  {
    key: 'issuer',
    get label() {
      return t('settings:access_team_domain');
    },
    group: 'network',
    get help() {
      return t('settings:for_example_https_your_team_cloudflareaccess_com');
    },
  },
  {
    key: 'audience',
    get label() {
      return t('settings:access_application_aud');
    },
    group: 'network',
    get help() {
      return t('settings:enter_the_cloudflare_access_application_s_audience');
    },
  },
  {
    key: 'binary',
    get label() {
      return t('settings:codex_executable');
    },
    group: 'codex',
    get help() {
      return t('settings:enter_codex_or_an_absolute_path_on_the');
    },
  },
  {
    key: 'home',
    get label() {
      return t('settings:codex_home_optional');
    },
    group: 'codex',
    get help() {
      return t('settings:leave_blank_to_inherit_the_service_environment_or');
    },
  },
  {
    key: 'requestTimeoutMs',
    get label() {
      return t('settings:request_timeout_milliseconds');
    },
    group: 'codex',
    type: 'number',
    get help() {
      return t('settings:range_100_300000_default_30000');
    },
  },
  sizeField('maxLineBytes', 'settings:codex_message_line_limit', 256, 64),
  sizeField('eventBytes', 'settings:event_buffer_limit', 64, 16),
  sizeField('wsBytes', 'settings:websocket_buffer_limit', 16, 4),
  sizeField('itemBytes', 'settings:item_content_limit', 8, 2),
  {
    key: 'developmentOrigins',
    get label() {
      return t('settings:development_origins');
    },
    group: 'advanced',
    multiline: true,
    get help() {
      return t('settings:one_local_http_s_origin_per_line_used');
    },
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
  const invalid = (reason: string) => ({
    bytes: NaN,
    error: t('settings:fieldError', { label: field.label, reason }),
  });
  const value = text.trim();
  if (!value) return invalid(t('settings:enter_a_value_in_mib'));
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)))
    return invalid(t('settings:enter_a_valid_mib_value_decimals_are_allowed'));
  if (Number(value) < 1 / 1024 || Number(value) > field.maxMiB)
    return invalid(t('settings:range', { v0: sizeRange(field.maxMiB) }));

  const [whole, decimal = ''] = value.replace(/^\+/, '').split('.');
  const fraction = decimal.replace(/0+$/, '');
  const fractionalByte = () => invalid(t('settings:the_mib_value_must_correspond_to_whole_bytes'));
  if (fraction.length > 20) return fractionalByte();
  const scale = 10n ** BigInt(fraction.length);
  const numerator = (BigInt(whole || '0') * scale + BigInt(fraction || '0')) * BigInt(MIB);
  if (numerator < 1024n * scale || numerator > BigInt(field.maxMiB * MIB) * scale)
    return invalid(t('settings:range', { v0: sizeRange(field.maxMiB) }));
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
    ...(a.mode === b.mode
      ? []
      : [{ label: t('common:authentication_mode'), before: a.mode, after: b.mode }]),
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
