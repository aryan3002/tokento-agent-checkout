// ============================================================
// Tokento — Error Middleware
// ============================================================
// Standardized error responses with reason codes.

import { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.name = 'AppError';
  }
}

// Errors from express.json() (body-parser) carry a `type` and a 4xx status.
// They are the caller's mistake, so they get a 4xx, not a 500 or a Sentry report.
const BODY_ERRORS: Record<string, { code: string; message: string }> = {
  'entity.parse.failed': { code: 'invalid_json', message: 'The request body is not valid JSON.' },
  'entity.too.large': { code: 'payload_too_large', message: 'The request body is too large.' },
};

function bodyError(err: Error): { status: number; code: string; message: string } | null {
  const { type, status } = err as Error & { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number' || status < 400 || status > 499) return null;
  const known = BODY_ERRORS[type];
  return { status, code: known?.code ?? 'invalid_request_body', message: known?.message ?? 'The request body could not be read.' };
}

/**
 * Global error handler middleware.
 */
export function errorHandler() {
  return (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    const badBody = bodyError(err);
    if (badBody) {
      res.status(badBody.status).json({
        error: { code: badBody.code, message: badBody.message },
        requestId: req.requestId || 'unknown',
      });
      return;
    }

    Sentry.withScope((scope) => {
      scope.setTag('request_id', req.requestId || 'unknown');
      scope.setTag('http_method', req.method);
      scope.setTag('http_path', req.path);
      Sentry.captureException(err);
    });

    // Zod validation errors
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'Request validation failed.',
          details: {
            issues: err.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
              code: issue.code,
            })),
          },
        },
        requestId: req.requestId || 'unknown',
      });
      return;
    }

    // Application errors
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
        requestId: req.requestId || 'unknown',
      });
      return;
    }

    // Unknown errors
    logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

    res.status(500).json({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred.',
      },
      requestId: req.requestId || 'unknown',
    });
  };
}

/**
 * 404 handler for unmatched routes.
 */
export function notFoundHandler() {
  return (req: Request, res: Response): void => {
    res.status(404).json({
      error: {
        code: 'not_found',
        message: `Route ${req.method} ${req.path} not found.`,
      },
      requestId: req.requestId || 'unknown',
    });
  };
}
