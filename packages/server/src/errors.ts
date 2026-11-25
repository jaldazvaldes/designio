import { OpError, ValidationError } from '@designio/core';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Traduce cualquier error a (estado HTTP, mensaje). */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof OpError || error instanceof ValidationError) return new HttpError(400, error.message);
  return new HttpError(500, errorMessage(error));
}
