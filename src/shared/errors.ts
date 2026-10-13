import type { ApiError } from './types.js';
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
  toJSON(clientOperationId?: string): ApiError {
    return {
      code: this.code,
      message: this.message,
      ...(clientOperationId ? { clientOperationId } : {}),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
