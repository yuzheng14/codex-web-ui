import { useState } from 'react';
import type {
  ActionResolution,
  ElicitationField,
  ElicitationRequest,
  ElicitationValue,
} from '../../shared/types';
import { validateElicitationFieldValue } from '../../shared/elicitation';
import { Button } from './ui/button';

type DraftValue = string | boolean | string[];
type Draft = Record<string, DraftValue | undefined>;

function initialDraft(fields: ElicitationField[]): Draft {
  return Object.fromEntries(
    fields
      .filter((field) => field.default !== undefined)
      .map((field) => [
        field.name,
        typeof field.default === 'number' ? String(field.default) : field.default,
      ]),
  );
}

function fieldHint(field: ElicitationField): string {
  const hints: string[] = [];
  if (field.type === 'integer') hints.push('填写整数');
  if (field.minimum !== undefined) hints.push(`最小 ${field.minimum}`);
  if (field.maximum !== undefined) hints.push(`最大 ${field.maximum}`);
  if (field.minLength !== undefined) hints.push(`至少 ${field.minLength} 个字符`);
  if (field.maxLength !== undefined) hints.push(`最多 ${field.maxLength} 个字符`);
  if (field.minItems !== undefined) hints.push(`至少选择 ${field.minItems} 项`);
  if (field.maxItems !== undefined) hints.push(`最多选择 ${field.maxItems} 项`);
  if (field.format === 'date-time')
    hints.push('日期与时间需包含时区，例如 2026-10-14T12:30:00+08:00');
  return hints.join(' · ');
}

function contentFor(fields: ElicitationField[], draft: Draft) {
  const content: Record<string, ElicitationValue> = Object.create(null);
  const errors: Record<string, string> = Object.create(null);
  for (const field of fields) {
    const value = Object.hasOwn(draft, field.name) ? draft[field.name] : undefined;
    if (
      value === undefined ||
      ((field.type === 'number' || field.type === 'integer') && value === '')
    ) {
      if (field.required) errors[field.name] = '请填写此必填项。';
      continue;
    }
    const typedValue = field.type === 'number' || field.type === 'integer' ? Number(value) : value;
    try {
      validateElicitationFieldValue(field, typedValue);
      content[field.name] = typedValue;
    } catch (error) {
      errors[field.name] = error instanceof Error ? error.message : '请检查此字段的填写要求。';
    }
  }
  return { content, errors };
}

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function ElicitationForm({
  request,
  actionId,
  disabled,
  onResolve,
}: {
  request: ElicitationRequest;
  actionId: string;
  disabled: boolean;
  onResolve: (resolution: ActionResolution) => void;
}) {
  const fields = request.fields ?? [];
  const [draft, setDraft] = useState<Draft>(() => initialDraft(fields));
  const [attempted, setAttempted] = useState(false);
  const { content, errors } = contentFor(fields, draft);
  const externalUrl = safeExternalUrl(request.url);
  const unavailable =
    request.schemaError ||
    (request.mode === 'url' && !externalUrl
      ? '此请求没有可安全打开的 HTTP 或 HTTPS 地址，无法确认完成。'
      : undefined);
  const change = (name: string, value: DraftValue | undefined) =>
    setDraft((previous) => ({ ...previous, [name]: value }));
  return (
    <form
      className="elicitation-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || unavailable) return;
        setAttempted(true);
        if (request.mode === 'form' && Object.keys(errors).length > 0) return;
        onResolve(
          request.mode === 'form' ? { decision: 'accept', content } : { decision: 'accept' },
        );
      }}
    >
      <p className="elicitation-source">
        来源：<strong>{request.serverName}</strong>
      </p>
      {unavailable && (
        <p className="elicitation-error" role="alert">
          {unavailable}
        </p>
      )}
      {request.mode === 'url' ? (
        <div className="elicitation-url">
          <span>访问地址</span>
          <code>{request.url ?? '未提供地址'}</code>
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              在新标签页打开
            </a>
          )}
          <p>完成页面中的操作后，点击“我已完成”继续。</p>
        </div>
      ) : (
        !unavailable && (
          <div className="elicitation-fields">
            {fields.map((field, index) => {
              const id = `elicitation-${actionId}-${index}`;
              const hint = fieldHint(field);
              const error = attempted ? errors[field.name] : undefined;
              const value = Object.hasOwn(draft, field.name) ? draft[field.name] : undefined;
              const describedBy =
                [
                  field.description && `${id}-description`,
                  hint && `${id}-hint`,
                  error && `${id}-error`,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined;
              return (
                <div key={field.name} className="elicitation-field">
                  <div className="elicitation-field-heading">
                    <label id={`${id}-label`} htmlFor={field.type === 'multiEnum' ? undefined : id}>
                      {field.title}
                      <span className="field-necessity" aria-hidden="true">
                        {field.required ? '必填' : '可选'}
                      </span>
                    </label>
                    {!field.required && value !== undefined && (
                      <button
                        type="button"
                        className="field-unset"
                        disabled={disabled}
                        onClick={() => change(field.name, undefined)}
                      >
                        不填写<span className="sr-only">{field.title}</span>
                      </button>
                    )}
                  </div>
                  {field.description && (
                    <p id={`${id}-description`} className="field-description">
                      {field.description}
                    </p>
                  )}
                  {field.type === 'boolean' || field.type === 'enum' ? (
                    <select
                      id={id}
                      className="text-input"
                      value={
                        value === undefined
                          ? ''
                          : field.type === 'boolean'
                            ? value
                              ? 'true'
                              : 'false'
                            : `option:${String(value)}`
                      }
                      disabled={disabled}
                      aria-required={field.required}
                      aria-invalid={Boolean(error)}
                      aria-describedby={describedBy}
                      onChange={(event) =>
                        change(
                          field.name,
                          event.target.value === ''
                            ? undefined
                            : field.type === 'boolean'
                              ? event.target.value === 'true'
                              : event.target.value.slice(7),
                        )
                      }
                    >
                      <option value="">请选择</option>
                      {field.type === 'boolean' ? (
                        <>
                          <option value="true">是</option>
                          <option value="false">否</option>
                        </>
                      ) : (
                        field.options?.map((option) => (
                          <option key={option.value} value={`option:${option.value}`}>
                            {option.label}
                          </option>
                        ))
                      )}
                    </select>
                  ) : field.type === 'multiEnum' ? (
                    <div
                      role="group"
                      aria-labelledby={`${id}-label`}
                      aria-describedby={describedBy}
                      aria-invalid={Boolean(error)}
                      className="elicitation-multi-options"
                    >
                      {field.options?.map((option) => (
                        <label className="question-option" key={option.value}>
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={Array.isArray(value) && value.includes(option.value)}
                            onChange={(event) => {
                              const selected = Array.isArray(value) ? value : [];
                              change(
                                field.name,
                                event.target.checked
                                  ? [...selected, option.value]
                                  : selected.filter((entry) => entry !== option.value),
                              );
                            }}
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <input
                      id={id}
                      className="text-input"
                      type={
                        field.type === 'number' || field.type === 'integer'
                          ? 'number'
                          : field.format === 'email'
                            ? 'email'
                            : field.format === 'uri'
                              ? 'url'
                              : field.format === 'date'
                                ? 'date'
                                : 'text'
                      }
                      value={typeof value === 'string' ? value : ''}
                      step={field.type === 'integer' ? 1 : 'any'}
                      min={field.minimum}
                      max={field.maximum}
                      disabled={disabled}
                      aria-required={field.required}
                      aria-invalid={Boolean(error)}
                      aria-describedby={describedBy}
                      placeholder={!field.required ? '未填写（可选）' : undefined}
                      autoComplete="off"
                      onChange={(event) => change(field.name, event.target.value)}
                    />
                  )}
                  {hint && (
                    <p id={`${id}-hint`} className="field-hint">
                      {hint}
                    </p>
                  )}
                  {error && (
                    <p id={`${id}-error`} className="elicitation-error" role="alert">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
      {attempted && Object.keys(errors).length > 0 && !unavailable && (
        <p className="elicitation-error" role="alert">
          请检查标出的字段后再提交。
        </p>
      )}
      <div className="action-options">
        {!unavailable && (
          <Button type="submit" disabled={disabled}>
            {request.mode === 'url' ? '我已完成' : '提交回答'}
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => onResolve({ decision: 'decline' })}
        >
          拒绝
        </Button>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => onResolve({ decision: 'cancel' })}
        >
          取消
        </Button>
      </div>
    </form>
  );
}
