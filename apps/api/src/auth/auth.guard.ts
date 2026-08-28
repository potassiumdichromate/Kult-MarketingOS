import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrivyAuthenticator, bearerToken, type AuthContext } from '@kult/auth';
import type { AppConfig } from '@kult/config';
import type { PrismaClient } from '@kult/database';
import {
  AuthenticationError,
  AuthorizationError,
  hasPermission,
  type OrganizationRole,
  type Permission,
} from '@kult/shared';
import { APP_CONFIG, PRISMA } from '../common/tokens.js';

/**
 * Authentication and authorization guards.
 *
 * Identity always comes from a verified Privy token. The organization and role
 * come from the OrganizationMember row for that user - never from a header,
 * query parameter, or request body. That is the single mechanism enforcing
 * tenant isolation at the edge.
 */

export const IS_PUBLIC = 'route:public';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMISSIONS = 'route:permissions';
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Injects the verified AuthContext into a handler parameter. */
export const Auth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const request = context.switchToHttp().getRequest<Request>();
  if (!request.auth) {
    throw new AuthenticationError('This route requires authentication.');
  }
  return request.auth;
});

/** The raw request id, for handlers that need to correlate work they enqueue. */
export const RequestId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  return context.switchToHttp().getRequest<Request>().requestId;
});

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly privy: PrivyAuthenticator;

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {
    this.privy = new PrivyAuthenticator(config);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request.header('authorization'));
    if (!token) {
      throw new AuthenticationError('An Authorization: Bearer <privy access token> header is required.');
    }

    const identity = await this.privy.verifyAccessToken(token);

    const user = await this.prisma.user.findUnique({
      where: { privyUserId: identity.privyUserId },
      select: {
        id: true,
        memberships: {
          select: { organizationId: true, role: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!user) {
      // The user is authenticated with Privy but has no local record yet.
      // GET /api/v1/me provisions it; every other route needs it to exist.
      throw new AuthenticationError(
        'This account has not been provisioned yet. Call GET /api/v1/me first.',
      );
    }

    // A caller may name an organization they belong to; otherwise the first is used.
    const requested = request.header('x-organization-id');
    const membership = requested
      ? user.memberships.find((entry) => entry.organizationId === requested)
      : user.memberships[0];

    if (!membership) {
      throw requested
        ? new AuthorizationError('You are not a member of the requested organization.')
        : new AuthenticationError(
            'This account does not belong to an organization yet. Complete onboarding first.',
          );
    }

    request.auth = {
      userId: user.id,
      privyUserId: identity.privyUserId,
      sessionId: identity.sessionId,
      organizationId: membership.organizationId,
      role: membership.role as OrganizationRole,
      requestId: request.requestId,
    };

    return true;
  }
}

/**
 * Enforces @RequirePermissions. Runs after AuthGuard, so request.auth is set.
 * A route with no declared permissions requires authentication only.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.auth;
    if (!auth) throw new AuthenticationError();

    for (const permission of required) {
      if (!hasPermission(auth.role, permission)) {
        throw new AuthorizationError(
          `Your role (${auth.role}) does not allow "${permission}".`,
          { role: auth.role, permission },
        );
      }
    }
    return true;
  }
}
