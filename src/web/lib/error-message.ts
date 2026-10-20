import type { ApiError } from '../../shared/types';
import { resources } from '../i18n/resources';
import { message } from '../i18n/messages';

/** Translate application error codes; keep the original problem available for diagnostics. */
export function errorMessage(problem: Pick<ApiError, 'code' | 'message'>) {
  if (problem.message.startsWith('\u0001covro-message:')) return problem.message;
  const aliases: Record<string, string> = {
    UNAUTHENTICATED: 'AUTH_REQUIRED',
    VALIDATION_ERROR: 'VALIDATION_FAILED',
    CONFIG_READ_FAILED: 'CONFIG_UNAVAILABLE',
    CONFIG_WRITE_FAILED: 'CONFIG_UNAVAILABLE',
    CONFIG_BUSY: 'OPERATION_BUSY',
    PROJECT_OWNERSHIP: 'PROJECT_UNAVAILABLE',
    HISTORY_CURSOR_EXPIRED: 'HISTORY_UNAVAILABLE',
    EXPORT_HISTORY_INCOMPLETE: 'HISTORY_UNAVAILABLE',
  };
  const code = aliases[problem.code] ?? problem.code;
  return code in resources.en.errors
    ? message(`errors:${code}`, { details: problem.message })
    : message('errors:httpFailure', { code, details: problem.message });
}
