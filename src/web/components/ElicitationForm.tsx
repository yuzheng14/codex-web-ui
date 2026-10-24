import { displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import { useState } from 'react';
import type {
  ActionResolution,
  ElicitationField,
  ElicitationRequest,
  ElicitationValue,
  PendingAction,
} from '../../shared/types';
import { validateElicitationFieldValue } from '../../shared/elicitation';
import { actionStatusLabel } from '../lib/action-status';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

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
  if (field.type === 'integer') hints.push(t('approvals:enter_an_integer'));
  if (field.minimum !== undefined) hints.push(t('approvals:minimum', { v0: field.minimum }));
  if (field.maximum !== undefined) hints.push(t('approvals:maximum', { v0: field.maximum }));
  if (field.minLength !== undefined)
    hints.push(t('approvals:at_least_characters', { count: field.minLength, v0: field.minLength }));
  if (field.maxLength !== undefined)
    hints.push(t('approvals:at_most_characters', { count: field.maxLength, v0: field.maxLength }));
  if (field.minItems !== undefined)
    hints.push(t('approvals:select_at_least_items', { count: field.minItems, v0: field.minItems }));
  if (field.maxItems !== undefined)
    hints.push(t('approvals:select_at_most_items', { count: field.maxItems, v0: field.maxItems }));
  if (field.format === 'date-time') hints.push(t('approvals:include_a_time_zone_e_g_2026_10'));
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
      if (field.required) errors[field.name] = t('approvals:this_field_is_required');
      continue;
    }
    const typedValue = field.type === 'number' || field.type === 'integer' ? Number(value) : value;
    try {
      validateElicitationFieldValue(field, typedValue);
      content[field.name] = typedValue;
    } catch {
      errors[field.name] = t('approvals:check_the_requirements_for_this_field');
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
  status,
  disabled,
  onResolve,
}: {
  request: ElicitationRequest;
  actionId: string;
  status: PendingAction['status'];
  disabled: boolean;
  onResolve: (resolution: ActionResolution) => void;
}) {
  const fields = request.fields ?? [];
  const submitLabel =
    status !== 'pending'
      ? actionStatusLabel(status)
      : request.approval
        ? t('approvals:allow_once')
        : request.mode === 'url'
          ? t('approvals:i_m_done')
          : fields.length === 0
            ? t('common:confirm_and_continue')
            : fields.every((field) => ['boolean', 'enum', 'multiEnum'].includes(field.type))
              ? t('common:confirm_selection')
              : t('common:submit_answer');
  const [draft, setDraft] = useState<Draft>(() => initialDraft(fields));
  const [attempted, setAttempted] = useState(false);
  const { content, errors } = contentFor(fields, draft);
  const externalUrl = safeExternalUrl(request.url);
  const unavailable =
    (request.schemaError ? t('errors:unsupportedSchema') : undefined) ||
    (request.mode === 'url' && !externalUrl
      ? t('approvals:this_request_has_no_safe_http_or_https')
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
          request.mode === 'form' && !request.approval
            ? { decision: 'accept', content }
            : { decision: 'accept' },
        );
      }}
    >
      <p className="elicitation-source">
        {t('approvals:source')}
        <strong>{request.serverName}</strong>
      </p>
      {request.approval?.allowSession && (
        <p className="elicitation-scope subtle">
          {t('approvals:session_approval_applies_only_to_this_request_s')}
        </p>
      )}
      {unavailable && (
        <p className="elicitation-error" role="alert">
          {unavailable}
        </p>
      )}
      {request.mode === 'url' ? (
        <div className="elicitation-url">
          <span>{t('approvals:url')}</span>
          <code>{request.url ?? t('approvals:no_url_provided')}</code>
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              {t('approvals:open_in_new_tab')}
            </a>
          )}
          <p>{t('approvals:complete_the_steps_on_the_page_then_click')}</p>
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
                        {field.required ? t('approvals:required') : t('approvals:optional')}
                      </span>
                    </label>
                    {!field.required && value !== undefined && (
                      <button
                        type="button"
                        className="field-unset"
                        disabled={disabled}
                        onClick={() => change(field.name, undefined)}
                      >
                        {t('approvals:leave_blank')}
                        <span className="sr-only">{field.title}</span>
                      </button>
                    )}
                  </div>
                  {field.description && (
                    <p id={`${id}-description`} className="field-description">
                      {field.description}
                    </p>
                  )}
                  {field.type === 'boolean' || field.type === 'enum' ? (
                    <Select
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
                      required={field.required}
                      onValueChange={(selected) =>
                        change(
                          field.name,
                          selected === '' || selected === 'unset'
                            ? undefined
                            : field.type === 'boolean'
                              ? selected === 'true'
                              : selected.slice(7),
                        )
                      }
                    >
                      <SelectTrigger
                        id={id}
                        aria-required={field.required}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                      >
                        <SelectValue placeholder={t('approvals:select_an_option')} />
                      </SelectTrigger>
                      <SelectContent align="start">
                        <SelectItem value="unset">{t('approvals:select_an_option')}</SelectItem>
                        {field.type === 'boolean' ? (
                          <>
                            <SelectItem value="true">{t('approvals:yes')}</SelectItem>
                            <SelectItem value="false">{t('approvals:no')}</SelectItem>
                          </>
                        ) : (
                          field.options?.map((option) => (
                            <SelectItem key={option.value} value={`option:${option.value}`}>
                              {option.label}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
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
                      placeholder={
                        !field.required ? t('approvals:not_provided_optional') : undefined
                      }
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
                      {displayMessage(error)}
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
          {t('approvals:check_the_highlighted_fields_before_submitting')}
        </p>
      )}
      <div className="action-options">
        {!unavailable && (
          <Button type="submit" disabled={disabled}>
            {submitLabel}
          </Button>
        )}
        {!unavailable && request.approval?.allowSession && (
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => onResolve({ decision: 'accept', persist: 'session' })}
          >
            {t('approvals:allow_for_this_session')}
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => onResolve({ decision: 'decline' })}
        >
          {t('approvals:deny')}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => onResolve({ decision: 'cancel' })}
        >
          {t('common:cancel')}
        </Button>
      </div>
    </form>
  );
}
