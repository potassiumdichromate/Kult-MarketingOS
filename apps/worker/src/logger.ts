import pino from 'pino';
import { redactSecrets } from '@kult/shared';

/**
 * Structured JSON logging.
 *
 * Every job log carries jobId, queue, organizationId and correlationId, so a
 * single request can be traced from the API call through the queue, the agent
 * execution, the publication, and the provider response.
 *
 * The redact paths below are a backstop. Values are also passed through
 * redactSecrets before logging, because a provider error body can carry a token
 * in a field name we did not anticipate.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'kult-worker' },
  redact: {
    paths: [
      'accessToken',
      'refreshToken',
      '*.accessToken',
      '*.refreshToken',
      '*.accessTokenEncrypted',
      '*.refreshTokenEncrypted',
      'authorization',
      '*.authorization',
      'clientSecret',
      '*.clientSecret',
      'apiKey',
      '*.apiKey',
      'codeVerifier',
      '*.codeVerifier',
    ],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export interface JobLogContext {
  queue: string;
  jobName: string;
  jobId: string;
  organizationId?: string;
  correlationId?: string;
}

export function jobLogger(context: JobLogContext) {
  return logger.child(redactSecrets(context) as unknown as Record<string, unknown>);
}

export type JobLogger = ReturnType<typeof jobLogger>;
