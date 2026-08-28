import type { TokenSet } from '@kult/integrations';
import { UnsupportedCapabilityError, type SocialProvider } from '@kult/shared';
import type { WorkerContext } from '../context.js';
import { logger } from '../logger.js';

/**
 * Social connection token handling for the worker.
 *
 * This is the only place in the worker that decrypts a stored token, and the
 * plaintext never leaves the returned TokenSet - it is not logged, not stored,
 * and not attached to any job payload.
 */

export interface LoadedConnection {
  id: string;
  organizationId: string;
  provider: SocialProvider;
  providerAccountId: string;
  accountName: string;
  accountUsername: string | null;
  metadata: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  status: string;
  tokens: TokenSet;
}

export const CONNECTION_SELECT = {
  id: true,
  organizationId: true,
  provider: true,
  providerAccountId: true,
  accountName: true,
  accountUsername: true,
  accessTokenEncrypted: true,
  refreshTokenEncrypted: true,
  expiresAt: true,
  scopes: true,
  metadata: true,
  capabilities: true,
  status: true,
} as const;

/** Refresh when the token expires within this window. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/**
 * Loads a connection and, when its access token is at or near expiry, refreshes
 * it before returning.
 *
 * Providers differ, and the difference is honoured rather than papered over:
 *  - X exchanges a refresh token (two-hour access tokens).
 *  - Instagram re-issues from the current long-lived token.
 *  - LinkedIn usually cannot refresh at all; the adapter raises
 *    UnsupportedCapabilityError, and the connection is marked EXPIRED so a human
 *    reconnects. We do not pretend the refresh happened.
 */
export async function loadConnectionWithValidToken(
  context: WorkerContext,
  connectionId: string,
): Promise<LoadedConnection> {
  const row = await context.prisma.socialConnection.findUnique({
    where: { id: connectionId },
    select: CONNECTION_SELECT,
  });

  if (!row) {
    throw new Error(`Social connection ${connectionId} no longer exists.`);
  }

  let tokens: TokenSet = {
    accessToken: context.secrets.decrypt(row.accessTokenEncrypted),
    ...(row.refreshTokenEncrypted
      ? { refreshToken: context.secrets.decrypt(row.refreshTokenEncrypted) }
      : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    scopes: row.scopes,
  };

  const expiringSoon =
    row.expiresAt !== null && row.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;

  if (expiringSoon) {
    const adapter = context.social.getConfigured(row.provider);
    // Instagram refreshes with the access token itself; the rest use the refresh token.
    const credential =
      row.provider === 'INSTAGRAM' ? tokens.accessToken : (tokens.refreshToken ?? '');

    try {
      const refreshed = await adapter.refreshToken(credential);

      await context.prisma.socialConnection.update({
        where: { id: connectionId },
        data: {
          accessTokenEncrypted: context.secrets.encrypt(refreshed.accessToken),
          ...(refreshed.refreshToken
            ? { refreshTokenEncrypted: context.secrets.encrypt(refreshed.refreshToken) }
            : {}),
          expiresAt: refreshed.expiresAt ?? null,
          ...(refreshed.scopes.length > 0 ? { scopes: refreshed.scopes } : {}),
          status: 'ACTIVE',
          lastValidatedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      tokens = {
        accessToken: refreshed.accessToken,
        ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
        scopes: refreshed.scopes.length > 0 ? refreshed.scopes : row.scopes,
      };

      logger.info(
        { connectionId, provider: row.provider },
        'Refreshed social connection access token',
      );
    } catch (error) {
      const reason =
        error instanceof UnsupportedCapabilityError
          ? error.requirement
          : error instanceof Error
            ? error.message
            : 'Token refresh failed.';

      await context.prisma.socialConnection.update({
        where: { id: connectionId },
        data: {
          status: 'EXPIRED',
          lastErrorCode: 'REFRESH_FAILED',
          lastErrorMessage: reason.slice(0, 1_000),
        },
      });

      throw new Error(
        `The ${row.provider} connection could not be renewed and needs to be reconnected. ${reason}`,
      );
    }
  }

  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    providerAccountId: row.providerAccountId,
    accountName: row.accountName,
    accountUsername: row.accountUsername,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    capabilities: (row.capabilities ?? {}) as Record<string, unknown>,
    status: row.status,
    tokens,
  };
}
