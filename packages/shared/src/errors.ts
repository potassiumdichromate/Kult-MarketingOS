/**
 * Typed application errors.
 *
 * Every error carries a stable machine-readable `code` and an HTTP status. The
 * API exception filter renders these as:
 *   { error: { code, message, requestId } }
 *
 * `message` is always safe to return to a client. Anything sensitive (provider
 * bodies, tokens, connection strings) belongs in `internalDetails`, which is
 * logged but never serialised into a response.
 */

export type ErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATION_FAILED'
  | 'FORBIDDEN'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'AI_PROVIDER_ERROR'
  | 'PUBLISHING_FAILED'
  | 'INTEGRATION_ERROR'
  | 'UNSUPPORTED_CAPABILITY'
  | 'NOT_CONFIGURED'
  | 'INTERNAL_ERROR';

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;
  /** Never serialised to clients. Logged for operators. */
  readonly internalDetails?: Record<string, unknown>;

  constructor(message: string, internalDetails?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    if (internalDetails) this.internalDetails = internalDetails;
    Error.captureStackTrace?.(this, new.target);
  }

  toResponse(requestId: string): { error: { code: ErrorCode; message: string; requestId: string } } {
    return { error: { code: this.code, message: this.message, requestId } };
  }
}

export class AuthenticationError extends AppError {
  readonly code = 'AUTHENTICATION_REQUIRED' as const;
  readonly status = 401;
  constructor(message = 'Authentication is required.', details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class InvalidCredentialsError extends AppError {
  readonly code = 'AUTHENTICATION_FAILED' as const;
  readonly status = 401;
  constructor(message = 'The supplied credentials are invalid.', details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class AuthorizationError extends AppError {
  readonly code = 'FORBIDDEN' as const;
  readonly status = 403;
  constructor(
    message = 'You do not have permission to perform this action.',
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_FAILED' as const;
  readonly status = 400;
  /** Field-level issues, safe to return: they describe the caller's own input. */
  readonly issues: Array<{ path: string; message: string }>;
  constructor(
    message = 'The request payload failed validation.',
    issues: Array<{ path: string; message: string }> = [],
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.issues = issues;
  }

  override toResponse(requestId: string) {
    return {
      error: { code: this.code, message: this.message, requestId, issues: this.issues },
    };
  }
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND' as const;
  readonly status = 404;
  constructor(resource = 'Resource', details?: Record<string, unknown>) {
    super(`${resource} was not found.`, details);
  }
}

export class ConflictError extends AppError {
  readonly code = 'CONFLICT' as const;
  readonly status = 409;
  constructor(message = 'The request conflicts with the current state.', details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class RateLimitError extends AppError {
  readonly code = 'RATE_LIMITED' as const;
  readonly status = 429;
  readonly retryAfterSeconds?: number;
  constructor(message = 'Rate limit exceeded.', retryAfterSeconds?: number, details?: Record<string, unknown>) {
    super(message, details);
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A downstream provider returned an error we could not recover from. */
export class ProviderError extends AppError {
  readonly code = 'PROVIDER_ERROR' as const;
  readonly status = 502;
  readonly provider: string;
  readonly providerStatus?: number;
  readonly providerCode?: string;
  /** True when a retry has a realistic chance of succeeding (429 / 5xx / network). */
  readonly retryable: boolean;

  constructor(
    provider: string,
    message: string,
    options: {
      providerStatus?: number;
      providerCode?: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, options.details);
    this.provider = provider;
    if (options.providerStatus !== undefined) this.providerStatus = options.providerStatus;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
    this.retryable = options.retryable ?? false;
  }
}

export class AIProviderError extends AppError {
  readonly code = 'AI_PROVIDER_ERROR' as const;
  readonly status = 502;
  readonly retryable: boolean;
  constructor(message: string, retryable = false, details?: Record<string, unknown>) {
    super(message, details);
    this.retryable = retryable;
  }
}

export class PublishingError extends AppError {
  readonly code = 'PUBLISHING_FAILED' as const;
  readonly status = 502;
  readonly provider: string;
  readonly retryable: boolean;
  constructor(provider: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message, details);
    this.provider = provider;
    this.retryable = retryable;
  }
}

export class IntegrationError extends AppError {
  readonly code = 'INTEGRATION_ERROR' as const;
  readonly status = 400;
  readonly provider: string;
  constructor(provider: string, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.provider = provider;
  }
}

/**
 * The requested operation is not offered by the provider's current official API,
 * or the connected account lacks the eligibility/permissions it requires.
 * This is surfaced verbatim in the UI - it is never swallowed or faked.
 */
export class UnsupportedCapabilityError extends AppError {
  readonly code = 'UNSUPPORTED_CAPABILITY' as const;
  readonly status = 422;
  readonly provider: string;
  readonly capability: string;
  /** Operator-facing instruction describing exactly what must be configured. */
  readonly requirement: string;

  constructor(provider: string, capability: string, requirement: string) {
    super(`${provider} cannot perform "${capability}". ${requirement}`);
    this.provider = provider;
    this.capability = capability;
    this.requirement = requirement;
  }

  override toResponse(requestId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        provider: this.provider,
        capability: this.capability,
        requirement: this.requirement,
      },
    };
  }
}

/** A feature was invoked whose required environment configuration is absent. */
export class NotConfiguredError extends AppError {
  readonly code = 'NOT_CONFIGURED' as const;
  readonly status = 503;
  readonly requiredVariables: string[];
  constructor(feature: string, requiredVariables: string[]) {
    super(
      `${feature} is not configured on this deployment. ` +
        `Set ${requiredVariables.join(', ')} and restart the service.`,
    );
    this.requiredVariables = requiredVariables;
  }

  override toResponse(requestId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        requiredVariables: this.requiredVariables,
      },
    };
  }
}

export class InternalError extends AppError {
  readonly code = 'INTERNAL_ERROR' as const;
  readonly status = 500;
  constructor(message = 'An unexpected error occurred.', details?: Record<string, unknown>) {
    super(message, details);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** True when re-attempting the operation is worthwhile. Never true for auth/permission failures. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  if (error instanceof PublishingError) return error.retryable;
  if (error instanceof AIProviderError) return error.retryable;
  if (error instanceof RateLimitError) return true;
  if (error instanceof AppError) return false;
  // Unknown/native errors (sockets, DNS, timeouts) are treated as transient.
  return true;
}
