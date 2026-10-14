import { AppError } from './errors.js';
import type {
  ActionResolution,
  ElicitationField,
  ElicitationRequest,
  ElicitationValue,
} from './types.js';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (value: object, key: string): boolean => Object.hasOwn(value, key);
const fail = (message: string): never => {
  throw new AppError('VALIDATION_ERROR', message);
};

function onlyKeys(value: Record<string, unknown>, keys: string[], context: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) fail(`${context}包含尚不支持的约束：${unknown}`);
}

function optionalText(value: Record<string, unknown>, key: string): string | undefined {
  if (!has(value, key)) return undefined;
  if (typeof value[key] !== 'string') fail(`${key} 必须是字符串`);
  return value[key] as string;
}

function limit(value: Record<string, unknown>, key: string, integer: boolean): number | undefined {
  if (!has(value, key)) return undefined;
  const number = value[key];
  if (
    typeof number !== 'number' ||
    !Number.isFinite(number) ||
    (integer && (!Number.isSafeInteger(number) || number < 0))
  )
    fail(`${key} 不是有效的${integer ? '非负整数' : '数值'}`);
  return number as number;
}

function enumOptions(schema: Record<string, unknown>, variant: 'oneOf' | 'anyOf' = 'oneOf') {
  let options: { value: string; label: string }[];
  if (has(schema, 'enum')) {
    const values = schema.enum;
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
      fail('枚举选项必须是字符串列表');
    const names = schema.enumNames;
    if (
      names !== undefined &&
      (!Array.isArray(names) ||
        names.length !== (values as string[]).length ||
        names.some((name) => typeof name !== 'string'))
    )
      fail('枚举标题必须与选项一一对应');
    if (has(schema, variant)) fail('不能同时提供多种枚举约束');
    options = (values as string[]).map((value, index) => ({
      value,
      label: (names as string[] | undefined)?.[index] ?? value,
    }));
  } else {
    if (has(schema, 'enumNames')) fail('枚举标题缺少 enum 选项');
    const values = schema[variant];
    if (!Array.isArray(values)) fail('缺少可用的枚举选项');
    options = (values as unknown[]).map((value) => {
      if (!record(value)) fail('枚举选项格式不受支持');
      const option = value as Record<string, unknown>;
      onlyKeys(option, ['const', 'title', 'description', 'type'], '枚举选项');
      if (typeof option.const !== 'string' || (has(option, 'type') && option.type !== 'string'))
        fail('仅支持字符串枚举选项');
      optionalText(option, 'description');
      return {
        value: option.const as string,
        label: optionalText(option, 'title') ?? String(option.const),
      };
    });
  }
  if (!options.length || new Set(options.map((option) => option.value)).size !== options.length)
    fail('枚举选项不能为空或重复');
  if (options.some((option) => option.value.length > 10_000)) fail('枚举值超过可提交的长度上限');
  return options;
}

function dateValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function formatValid(format: ElicitationField['format'], value: string): boolean {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'uri':
      try {
        return !/\s/.test(value) && Boolean(new URL(value).protocol);
      } catch {
        return false;
      }
    case 'date':
      return dateValid(value);
    case 'date-time': {
      const match =
        /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(
          value,
        );
      return Boolean(
        match &&
        dateValid(match[1]!) &&
        Number(match[2]) <= 23 &&
        Number(match[3]) <= 59 &&
        Number(match[4]) <= 59 &&
        (match[5] === undefined || Number(match[5]) <= 23) &&
        (match[6] === undefined || Number(match[6]) <= 59) &&
        Number.isFinite(Date.parse(value)),
      );
    }
    default:
      return true;
  }
}

export function validateElicitationFieldValue(
  field: ElicitationField,
  value: unknown,
): asserts value is ElicitationValue {
  const invalid = () => fail(`“${field.title}”的回答不符合字段要求`);
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') invalid();
      else {
        const length = [...value].length;
        if (
          (field.minLength !== undefined && length < field.minLength) ||
          (field.maxLength !== undefined && length > field.maxLength) ||
          value.length > 10_000 ||
          !formatValid(field.format, value)
        )
          invalid();
      }
      break;
    case 'number':
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (field.type === 'integer' && !Number.isSafeInteger(value)) ||
        (field.minimum !== undefined && value < field.minimum) ||
        (field.maximum !== undefined && value > field.maximum)
      )
        invalid();
      break;
    case 'boolean':
      if (typeof value !== 'boolean') invalid();
      break;
    case 'enum':
      if (
        typeof value !== 'string' ||
        value.length > 10_000 ||
        !field.options?.some((option) => option.value === value)
      )
        invalid();
      break;
    case 'multiEnum':
      if (
        !Array.isArray(value) ||
        value.some(
          (item) =>
            typeof item !== 'string' ||
            item.length > 10_000 ||
            !field.options?.some((option) => option.value === item),
        ) ||
        value.length > 500 ||
        new Set(value).size !== value.length ||
        (field.minItems !== undefined && value.length < field.minItems) ||
        (field.maxItems !== undefined && value.length > field.maxItems)
      )
        invalid();
      break;
  }
}

function normalizeField(name: string, value: unknown, required: boolean): ElicitationField {
  // Zod's HTTP record parser discards this own key; never offer a field it cannot round-trip.
  if (name === '__proto__') fail('字段名称 __proto__ 不受当前表单传输支持');
  if (name.length > 1000) fail('字段名称超过可提交的长度上限');
  if (!record(value)) fail(`字段 ${name} 的定义格式不受支持`);
  const schema = value as Record<string, unknown>;
  const commonKeys = ['type', 'title', 'description', 'default'];
  const field: ElicitationField = {
    name,
    title: optionalText(schema, 'title') ?? name,
    description: optionalText(schema, 'description'),
    required,
    type: 'string',
  };
  switch (schema.type) {
    case 'string':
      if (has(schema, 'enum') || has(schema, 'oneOf') || has(schema, 'enumNames')) {
        onlyKeys(schema, [...commonKeys, 'enum', 'enumNames', 'oneOf'], `字段 ${name}`);
        field.type = 'enum';
        field.options = enumOptions(schema);
      } else {
        onlyKeys(schema, [...commonKeys, 'minLength', 'maxLength', 'format'], `字段 ${name}`);
        field.minLength = limit(schema, 'minLength', true);
        field.maxLength = limit(schema, 'maxLength', true);
        if (field.minLength !== undefined && field.minLength > 10_000)
          fail(`字段 ${name} 的最小长度超过可提交的长度上限`);
        if (
          field.minLength !== undefined &&
          field.maxLength !== undefined &&
          field.minLength > field.maxLength
        )
          fail(`字段 ${name} 的长度范围无效`);
        if (has(schema, 'format')) {
          if (!['email', 'uri', 'date', 'date-time'].includes(String(schema.format)))
            fail(`字段 ${name} 的 format 不受支持`);
          field.format = schema.format as ElicitationField['format'];
        }
      }
      break;
    case 'number':
    case 'integer':
      onlyKeys(schema, [...commonKeys, 'minimum', 'maximum'], `字段 ${name}`);
      field.type = schema.type;
      field.minimum = limit(schema, 'minimum', false);
      field.maximum = limit(schema, 'maximum', false);
      if (
        field.minimum !== undefined &&
        field.maximum !== undefined &&
        field.minimum > field.maximum
      )
        fail(`字段 ${name} 的数值范围无效`);
      break;
    case 'boolean':
      onlyKeys(schema, commonKeys, `字段 ${name}`);
      field.type = 'boolean';
      break;
    case 'array': {
      onlyKeys(
        schema,
        [...commonKeys, 'items', 'minItems', 'maxItems', 'uniqueItems'],
        `字段 ${name}`,
      );
      if (has(schema, 'uniqueItems') && schema.uniqueItems !== true)
        fail(`字段 ${name} 仅支持不重复的多选项`);
      if (!record(schema.items)) fail(`字段 ${name} 缺少有效的多选项`);
      const items = schema.items as Record<string, unknown>;
      onlyKeys(items, ['type', 'enum', 'enumNames', 'anyOf'], `字段 ${name} 的多选项`);
      if (has(items, 'type') && items.type !== 'string') fail(`字段 ${name} 仅支持字符串多选项`);
      field.type = 'multiEnum';
      field.options = enumOptions(items, 'anyOf');
      field.minItems = limit(schema, 'minItems', true);
      field.maxItems = limit(schema, 'maxItems', true);
      if (field.minItems !== undefined && field.minItems > 500)
        fail(`字段 ${name} 的最少选项数超过可提交的数量上限`);
      if (
        field.minItems !== undefined &&
        field.maxItems !== undefined &&
        field.minItems > field.maxItems
      )
        fail(`字段 ${name} 的选项数量范围无效`);
      break;
    }
    default:
      fail(`字段 ${name} 的类型不受支持：${String(schema.type)}`);
  }
  if (has(schema, 'default')) {
    validateElicitationFieldValue(field, schema.default);
    field.default = schema.default as ElicitationValue;
  }
  return field;
}

/** A deliberately bounded form contract: unknown constraints disable acceptance, never disappear. */
export function normalizeElicitationSchema(
  schema: unknown,
): Pick<ElicitationRequest, 'fields' | 'schemaError'> {
  try {
    if (!record(schema)) fail('表单结构必须是 JSON 对象');
    const root = schema as Record<string, unknown>;
    onlyKeys(
      root,
      ['$schema', 'type', 'title', 'description', 'properties', 'required', 'additionalProperties'],
      '表单',
    );
    if (root.type !== 'object' || !record(root.properties))
      fail('仅支持包含 properties 的扁平对象表单');
    optionalText(root, '$schema');
    optionalText(root, 'title');
    optionalText(root, 'description');
    if (has(root, 'additionalProperties') && typeof root.additionalProperties !== 'boolean')
      fail('additionalProperties 约束不受支持');
    const properties = root.properties as Record<string, unknown>;
    const required = has(root, 'required') ? root.required : [];
    if (
      !Array.isArray(required) ||
      required.some((name) => typeof name !== 'string' || !has(properties, name)) ||
      new Set(required as unknown[]).size !== (required as unknown[]).length
    )
      fail('必填字段必须存在于表单中');
    return {
      fields: Object.entries(properties).map(([name, value]) =>
        normalizeField(name, value, (required as string[]).includes(name)),
      ),
    };
  } catch (error) {
    return { fields: [], schemaError: error instanceof Error ? error.message : '表单结构不受支持' };
  }
}

export function normalizeElicitationRequest(params: Record<string, unknown>): ElicitationRequest {
  const base = { serverName: typeof params.serverName === 'string' ? params.serverName : 'MCP' };
  if (params.mode === 'url') {
    const url = typeof params.url === 'string' ? params.url : '';
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error('unsupported URL');
      return { ...base, mode: 'url', url };
    } catch {
      return {
        ...base,
        mode: 'url',
        url,
        schemaError: '此请求的链接无效；仅支持 HTTP 或 HTTPS 链接',
      };
    }
  }
  if (['form', 'openai/form', 'openaiForm'].includes(String(params.mode)))
    return { ...base, mode: 'form', ...normalizeElicitationSchema(params.requestedSchema) };
  return {
    ...base,
    mode: 'form',
    fields: [],
    schemaError: `尚不支持的交互模式：${String(params.mode)}`,
  };
}

/** Called before claiming an action and again against the adapter's original request. */
export function validateElicitationResolution(
  request: ElicitationRequest | undefined,
  resolution: ActionResolution,
): Record<string, ElicitationValue> | null {
  if (!record(resolution)) fail('请提交有效的交互回答');
  onlyKeys(resolution as Record<string, unknown>, ['decision', 'content'], '交互回答');
  if (!('decision' in resolution) || !['accept', 'decline', 'cancel'].includes(resolution.decision))
    fail('此请求不支持所提交的决定');
  const answer = resolution as { decision: string; content?: Record<string, ElicitationValue> };
  if (answer.decision !== 'accept') {
    if (has(answer, 'content')) fail('拒绝或取消时不能提交表单内容');
    return null;
  }
  if (!request || request.schemaError) fail(request?.schemaError ?? '交互请求缺少表单信息');
  const elicitation = request as ElicitationRequest;
  if (elicitation.mode === 'url') {
    const checked = normalizeElicitationRequest({
      mode: 'url',
      serverName: elicitation.serverName,
      url: elicitation.url,
    });
    if (checked.schemaError) fail(checked.schemaError);
    if (has(answer, 'content')) fail('链接确认不能提交表单内容');
    return null;
  }
  if (!record(answer.content)) fail('请提交结构化的表单回答');
  const content = answer.content as Record<string, ElicitationValue>;
  if (!Array.isArray(elicitation.fields)) fail('交互请求缺少表单字段');
  const fields = elicitation.fields!;
  if (Object.keys(content).some((name) => !fields.some((field) => field.name === name)))
    fail('回答包含未知字段');
  for (const field of fields) {
    if (!has(content, field.name)) {
      if (field.required) fail(`请填写“${field.title}”`);
    } else validateElicitationFieldValue(field, content[field.name]);
  }
  return structuredClone(content);
}

export function validatePermissionResolution(
  resolution: ActionResolution,
): 'accept' | 'acceptForSession' | 'decline' {
  if (!record(resolution)) fail('请提交有效的权限决定');
  onlyKeys(resolution as Record<string, unknown>, ['decision'], '权限回答');
  if (
    !('decision' in resolution) ||
    !['accept', 'acceptForSession', 'decline'].includes(resolution.decision)
  )
    fail('请选择当前任务允许、会话允许或拒绝');
  return (resolution as { decision: 'accept' | 'acceptForSession' | 'decline' }).decision;
}
