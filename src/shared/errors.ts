import type { ErrorCode } from './types';

/** A job failure with a reason the UI can show in plain language. */
export class JobError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'JobError';
  }
}

export function toJobError(err: unknown): JobError {
  if (err instanceof JobError) return err;
  if (err instanceof DOMException) {
    if (err.name === 'AbortError') return new JobError('canceled');
    if (err.name === 'QuotaExceededError') return new JobError('disk', err.message);
  }
  if (err instanceof TypeError) return new JobError('network', err.message);
  return new JobError('unknown', err instanceof Error ? err.message : String(err));
}
