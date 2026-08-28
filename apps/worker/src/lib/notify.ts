import { redactSecrets } from '@kult/shared';
import type { WorkerContext } from '../context.js';
import { logger } from '../logger.js';

/**
 * Notification and audit helpers for the worker.
 *
 * Both are best-effort: failing to record a notification or an audit entry must
 * never fail the job that produced it. Failures are logged so they are visible
 * rather than silent.
 */

export type NotificationType =
  | 'APPROVAL_REQUIRED'
  | 'PUBLISHING_SUCCEEDED'
  | 'PUBLISHING_FAILED'
  | 'OAUTH_DISCONNECTED'
  | 'TOKEN_EXPIRED'
  | 'CAMPAIGN_COMPLETED'
  | 'OPPORTUNITY_DISCOVERED'
  | 'RESEARCH_COMPLETED';

export async function notify(
  context: WorkerContext,
  input: {
    organizationId: string;
    /** Null notifies the whole organization. */
    userId?: string | null;
    type: NotificationType;
    severity?: 'INFO' | 'WARNING' | 'ERROR';
    title: string;
    body?: string | null;
    resourceType?: string;
    resourceId?: string;
  },
): Promise<void> {
  try {
    await context.prisma.notification.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        type: input.type,
        severity: input.severity ?? 'INFO',
        title: input.title.slice(0, 300),
        body: input.body?.slice(0, 4_000) ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
      },
    });
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error), type: input.type },
      'Failed to create notification',
    );
  }
}

export async function audit(
  context: WorkerContext,
  input: {
    action: string;
    organizationId: string;
    actorUserId?: string | null;
    actorType?: 'USER' | 'AGENT' | 'SYSTEM';
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await context.prisma.auditLog.create({
      data: {
        action: input.action,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? null,
        // A job with no user behind it is the system acting, not a person.
        actorType: input.actorType ?? (input.actorUserId ? 'USER' : 'SYSTEM'),
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        metadata: redactSecrets(input.metadata ?? {}) as object,
      },
    });
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error), action: input.action },
      'Failed to write audit log entry',
    );
  }
}
