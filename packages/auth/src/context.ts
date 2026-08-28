import {
  AuthorizationError,
  hasPermission,
  type OrganizationRole,
  type Permission,
} from '@kult/shared';

/**
 * The authenticated request context.
 *
 * Constructed server-side from a verified Privy token plus the caller's
 * membership row. Nothing in here is ever taken from the request body or from a
 * client-supplied header.
 */
export interface AuthContext {
  userId: string;
  privyUserId: string;
  sessionId: string;
  organizationId: string;
  role: OrganizationRole;
  /** Correlates logs, agent executions, and audit entries for this request. */
  requestId: string;
}

/** Actor descriptor written into audit and attribution records. */
export interface ActorRef {
  actorType: 'USER' | 'AGENT' | 'SYSTEM';
  userId?: string;
  agentName?: string;
}

export function userActor(context: AuthContext): ActorRef {
  return { actorType: 'USER', userId: context.userId };
}

export function agentActor(agentName: string, onBehalfOfUserId?: string): ActorRef {
  return {
    actorType: 'AGENT',
    agentName,
    ...(onBehalfOfUserId ? { userId: onBehalfOfUserId } : {}),
  };
}

export const systemActor: ActorRef = { actorType: 'SYSTEM' };

/**
 * Central permission assertion. Guards, services, and the copilot tool layer all
 * funnel through this so a permission decision is made in exactly one place.
 */
export function assertPermission(context: AuthContext, permission: Permission): void {
  if (!hasPermission(context.role, permission)) {
    throw new AuthorizationError(
      `Your role (${context.role}) does not allow "${permission}".`,
      { role: context.role, permission },
    );
  }
}

export function assertEveryPermission(context: AuthContext, permissions: Permission[]): void {
  for (const permission of permissions) assertPermission(context, permission);
}

/** Non-throwing variant, for shaping responses rather than rejecting them. */
export function can(context: AuthContext, permission: Permission): boolean {
  return hasPermission(context.role, permission);
}
