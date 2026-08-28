import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { PrismaClient } from '@kult/database';
import type { AuthContext } from '@kult/auth';
import { redactSecrets } from '@kult/shared';
import { PRISMA } from './tokens.js';

/**
 * Audit logging.
 *
 * Every security-relevant and state-changing action is recorded with the actor,
 * the organization, the resource, the source IP, and the user agent. Metadata is
 * redacted before it is written, so a caller cannot cause a token to be
 * persisted by passing one in a field an audit record happens to capture.
 *
 * Writing an audit row must never break the operation being audited: a failure
 * here is logged and swallowed, because losing the action is worse than losing
 * its audit entry - and the failure itself is visible in the logs.
 */

export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'organization.created'
  | 'organization.updated'
  | 'organization.member_invited'
  | 'organization.member_role_changed'
  | 'organization.member_removed'
  | 'knowledge.created'
  | 'knowledge.deleted'
  | 'integrations.connected'
  | 'integrations.disconnected'
  | 'integrations.validated'
  | 'content.created'
  | 'content.updated'
  | 'content.generated'
  | 'content.approved'
  | 'content.rejected'
  | 'content.scheduled'
  | 'content.publish_requested'
  | 'content.published'
  | 'content.publish_failed'
  | 'content.cancelled'
  | 'content.deleted'
  | 'campaign.created'
  | 'campaign.activated'
  | 'campaign.paused'
  | 'automation.mode_changed'
  | 'automation.autopilot_enabled'
  | 'automation.autopilot_disabled'
  | 'research.run_requested'
  | 'agent.tool_invoked'
  | 'insight.accepted'
  | 'insight.rejected';

export interface AuditInput {
  action: AuditAction;
  organizationId?: string | null;
  actorUserId?: string | null;
  actorType?: 'USER' | 'AGENT' | 'SYSTEM';
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async record(input: AuditInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: input.action,
          organizationId: input.organizationId ?? null,
          actorUserId: input.actorUserId ?? null,
          actorType: input.actorType ?? 'USER',
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
          metadata: redactSecrets(input.metadata ?? {}) as object,
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 1_000) ?? null,
        },
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to write audit log entry.',
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Convenience wrapper that pulls actor and network details off the request. */
  async fromRequest(
    request: Request,
    auth: AuthContext,
    input: Omit<AuditInput, 'organizationId' | 'actorUserId' | 'ip' | 'userAgent'>,
  ): Promise<void> {
    await this.record({
      ...input,
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      ip: clientIp(request),
      userAgent: request.header('user-agent') ?? null,
    });
  }
}

/**
 * Resolves the client IP.
 *
 * Express only populates `req.ips` from X-Forwarded-For when `trust proxy` is
 * configured, which main.ts does for the nginx hop. Without that, a client could
 * spoof the header and poison the audit trail.
 */
export function clientIp(request: Request): string | null {
  return request.ips?.[0] ?? request.ip ?? null;
}
