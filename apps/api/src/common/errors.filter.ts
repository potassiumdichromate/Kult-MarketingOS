import {
  Catch,
  HttpException,
  Inject,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import type { AppConfig } from '@kult/config';
import { AppError, RateLimitError, ValidationError, redactSecrets } from '@kult/shared';
import { APP_CONFIG } from './tokens.js';

/**
 * Renders every failure as the documented error envelope:
 *
 *   { "error": { "code", "message", "requestId" } }
 *
 * Stack traces and internal details are logged, never serialised. An unexpected
 * exception becomes a generic INTERNAL_ERROR in production so an accidental
 * `throw new Error(connectionString)` cannot leak through the API.
 */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorsFilter');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const requestId = (request as Request & { requestId?: string }).requestId ?? 'unknown';

    const normalised = this.normalise(exception);

    if (normalised.status >= 500) {
      this.logger.error({
        requestId,
        status: normalised.status,
        code: normalised.body.error.code,
        path: request.originalUrl,
        method: request.method,
        message: normalised.logMessage,
        details: normalised.internalDetails,
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    } else {
      // internalDetails carries the operator-only reason behind a 4xx: why Privy
      // rejected a token, which app id it was minted for, what a provider said.
      // It is already redacted, and it is the only place that reason survives.
      this.logger.warn({
        requestId,
        status: normalised.status,
        code: normalised.body.error.code,
        path: request.originalUrl,
        method: request.method,
        message: normalised.logMessage,
        ...(normalised.internalDetails ? { details: normalised.internalDetails } : {}),
      });
    }

    if (normalised.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(normalised.retryAfterSeconds));
    }

    response.status(normalised.status).json({
      ...normalised.body,
      error: { ...normalised.body.error, requestId },
    });
  }

  private normalise(exception: unknown): {
    status: number;
    body: { error: { code: string; message: string; requestId: string; [key: string]: unknown } };
    logMessage: string;
    internalDetails?: Record<string, unknown>;
    retryAfterSeconds?: number;
  } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: exception.toResponse('') as never,
        logMessage: exception.message,
        ...(exception.internalDetails
          ? { internalDetails: redactSecrets(exception.internalDetails) }
          : {}),
        ...(exception instanceof RateLimitError && exception.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: exception.retryAfterSeconds }
          : {}),
      };
    }

    // Zod errors that escaped a pipe are still the caller's input problem.
    if (exception instanceof ZodError) {
      const validation = new ValidationError(
        'The request payload failed validation.',
        exception.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
      return {
        status: validation.status,
        body: validation.toResponse('') as never,
        logMessage: validation.message,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      return {
        status,
        body: {
          error: {
            code: httpStatusToCode(status),
            message: Array.isArray(message) ? message.join('; ') : message,
            requestId: '',
          },
        },
        logMessage: exception.message,
      };
    }

    // Anything else is unexpected. Never surface its message in production.
    const message = exception instanceof Error ? exception.message : String(exception);
    return {
      status: 500,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: this.config.isProduction
            ? 'An unexpected error occurred.'
            : `An unexpected error occurred: ${message}`,
          requestId: '',
        },
      },
      logMessage: message,
    };
  }
}

function httpStatusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'AUTHENTICATION_REQUIRED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  }
}
