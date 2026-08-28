import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthContext } from '@kult/auth';
import type { AppConfig } from '@kult/config';
import type { PrismaClient } from '@kult/database';
import {
  SecretBox,
  SocialProviderRegistry,
  createOAuthState,
  createPkcePair,
  requiredVariables,
  type SocialProviderAdapter,
  type TokenSet,
} from '@kult/integrations';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  UnsupportedCapabilityError,
  ValidationError,
  type SocialProvider,
} from '@kult/shared';
import { APP_CONFIG, PRISMA, SECRET_BOX, SOCIAL_REGISTRY } from '../../common/tokens.js';

/**
 * Social integration lifecycle.
 *
 * Security properties this service is responsible for:
 *  - OAuth `state` is single-use, bound to a user, organization, and provider,
 *    and expires. A callback whose state does not match is rejected outright.
 *  - The PKCE verifier is encrypted at rest, because it is a bearer credential
 *    for the authorization code between the two legs of the flow.
 *  - Access and refresh tokens are only ever written through SecretBox, and no
 *    method on this service returns a token to a caller.
 */

/** OAuth authorizations must complete promptly; a stale state is not accepted. */
const STATE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger('Integrations');

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRET_BOX) private readonly secrets: SecretBox,
    @Inject(SOCIAL_REGISTRY) private readonly registry: SocialProviderRegistry,
  ) {}

  /**
   * Lists every provider with its configuration status and current connections.
   * Deliberately includes unconfigured providers so an operator sees what exists
   * and precisely what is missing.
   */
  async list(auth: AuthContext) {
    const connections = await this.prisma.socialConnection.findMany({
      where: { organizationId: auth.organizationId },
      select: {
        id: true,
        provider: true,
        providerAccountId: true,
        accountName: true,
        accountUsername: true,
        scopes: true,
        status: true,
        expiresAt: true,
        metadata: true,
        capabilities: true,
        lastValidatedAt: true,
        lastErrorCode: true,
        lastErrorMessage: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const providers = this.registry.all().map((adapter) => {
      const providerConnections = connections.filter(
        (connection) => connection.provider === adapter.name,
      );
      return {
        provider: adapter.name,
        configured: adapter.configured,
        requestedScopes: adapter.requestedScopes,
        ...(adapter.configured
          ? {}
          : {
              configurationRequirement: {
                message:
                  `The ${adapter.name} integration is not configured on this deployment.`,
                requiredVariables: requiredVariables(adapter.name),
              },
            }),
        connections: providerConnections.map((connection) => ({
          ...connection,
          // Surface expiry as a derived state so the UI does not re-implement it.
          tokenExpired: connection.expiresAt ? connection.expiresAt.getTime() < Date.now() : false,
        })),
      };
    });

    return { providers };
  }

  /**
   * Starts an authorization. Persists state (and the encrypted PKCE verifier)
   * before returning the redirect URL, so a callback can always be validated.
   */
  async beginAuthorization(
    auth: AuthContext,
    provider: SocialProvider,
    redirectPath?: string,
  ): Promise<{ authorizationUrl: string; state: string; expiresAt: Date }> {
    const adapter = this.registry.getConfigured(provider);
    const state = createOAuthState();

    // Only X uses PKCE among the implemented providers; the adapter declares it
    // by requiring a verifier in getAuthorizationUrl.
    const usesPkce = provider === 'X';
    const pkce = usesPkce ? createPkcePair() : undefined;

    const authorization = adapter.getAuthorizationUrl({
      state,
      ...(pkce ? { codeVerifier: pkce.codeVerifier } : {}),
    });

    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    await this.prisma.oAuthState.create({
      data: {
        state,
        organizationId: auth.organizationId,
        userId: auth.userId,
        provider,
        codeVerifierEncrypted: pkce ? this.secrets.encrypt(pkce.codeVerifier) : null,
        // Only same-site relative paths are stored, so the callback cannot be
        // used as an open redirect.
        redirectPath: sanitizeRedirectPath(redirectPath),
        expiresAt,
      },
    });

    return { authorizationUrl: authorization.url, state, expiresAt };
  }

  /**
   * Completes an authorization.
   *
   * Runs entirely from the persisted state row: the organization and user come
   * from that record, never from the callback request, because the callback
   * arrives as a browser redirect with no bearer token.
   */
  async completeAuthorization(input: {
    provider: SocialProvider;
    code: string;
    state: string;
  }): Promise<{ organizationId: string; connectionId: string; redirectPath: string | null }> {
    const stateRow = await this.prisma.oAuthState.findUnique({
      where: { state: input.state },
      select: {
        id: true,
        organizationId: true,
        userId: true,
        provider: true,
        codeVerifierEncrypted: true,
        redirectPath: true,
        expiresAt: true,
        consumedAt: true,
      },
    });

    if (!stateRow) {
      throw new AuthorizationError(
        'This authorization request is not recognised. Start the connection again.',
      );
    }
    if (stateRow.consumedAt) {
      throw new ConflictError('This authorization has already been completed.');
    }
    if (stateRow.expiresAt.getTime() < Date.now()) {
      throw new AuthorizationError('This authorization request expired. Start the connection again.');
    }
    if (stateRow.provider !== input.provider) {
      throw new AuthorizationError('The authorization provider does not match the callback.');
    }

    // Consume the state immediately, so a replayed callback cannot mint a
    // second connection even if the exchange below is slow.
    const consumed = await this.prisma.oAuthState.updateMany({
      where: { id: stateRow.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      throw new ConflictError('This authorization has already been completed.');
    }

    const adapter = this.registry.getConfigured(input.provider);
    const codeVerifier = stateRow.codeVerifierEncrypted
      ? this.secrets.decrypt(stateRow.codeVerifierEncrypted)
      : undefined;

    const tokens = await adapter.handleOAuthCallback({
      code: input.code,
      ...(codeVerifier ? { codeVerifier } : {}),
    });

    const account = await adapter.getAccount(tokens);
    const capabilities = await adapter.resolveCapabilities({ tokens, account });

    const connection = await this.prisma.socialConnection.upsert({
      where: {
        organizationId_provider_providerAccountId: {
          organizationId: stateRow.organizationId,
          provider: input.provider,
          providerAccountId: account.providerAccountId,
        },
      },
      create: {
        organizationId: stateRow.organizationId,
        provider: input.provider,
        providerAccountId: account.providerAccountId,
        accountName: account.accountName,
        accountUsername: account.accountUsername ?? null,
        accessTokenEncrypted: this.secrets.encrypt(tokens.accessToken),
        refreshTokenEncrypted: this.secrets.encryptOptional(tokens.refreshToken),
        expiresAt: tokens.expiresAt ?? null,
        scopes: tokens.scopes,
        metadata: account.metadata as object,
        capabilities: capabilities as unknown as object,
        status: 'ACTIVE',
        lastValidatedAt: new Date(),
        connectedById: stateRow.userId,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      update: {
        accountName: account.accountName,
        accountUsername: account.accountUsername ?? null,
        accessTokenEncrypted: this.secrets.encrypt(tokens.accessToken),
        refreshTokenEncrypted: this.secrets.encryptOptional(tokens.refreshToken),
        expiresAt: tokens.expiresAt ?? null,
        scopes: tokens.scopes,
        metadata: account.metadata as object,
        capabilities: capabilities as unknown as object,
        status: 'ACTIVE',
        lastValidatedAt: new Date(),
        connectedById: stateRow.userId,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      select: { id: true },
    });

    return {
      organizationId: stateRow.organizationId,
      connectionId: connection.id,
      redirectPath: stateRow.redirectPath,
    };
  }

  /** Re-checks a connection against the provider and refreshes stored capabilities. */
  async validate(auth: AuthContext, connectionId: string) {
    const connection = await this.requireConnection(auth, connectionId);
    const adapter = this.registry.getConfigured(connection.provider);
    const tokens = this.decryptTokens(connection);

    const result = await adapter.validateConnection(tokens);

    if (!result.valid) {
      await this.prisma.socialConnection.update({
        where: { id: connectionId },
        data: {
          status: result.requiresReauthorization ? 'EXPIRED' : 'ERROR',
          lastValidatedAt: new Date(),
          lastErrorCode: result.requiresReauthorization ? 'REAUTHORIZATION_REQUIRED' : 'VALIDATION_FAILED',
          lastErrorMessage: result.reason?.slice(0, 1_000) ?? null,
        },
      });
      return {
        valid: false,
        status: result.requiresReauthorization ? 'EXPIRED' : 'ERROR',
        reason: result.reason,
        requiresReauthorization: result.requiresReauthorization ?? false,
      };
    }

    await this.prisma.socialConnection.update({
      where: { id: connectionId },
      data: {
        status: 'ACTIVE',
        lastValidatedAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
        ...(result.account
          ? {
              accountName: result.account.accountName,
              accountUsername: result.account.accountUsername ?? null,
              metadata: result.account.metadata as object,
            }
          : {}),
        ...(result.capabilities ? { capabilities: result.capabilities as unknown as object } : {}),
      },
    });

    return {
      valid: true,
      status: 'ACTIVE',
      account: result.account,
      capabilities: result.capabilities,
    };
  }

  /**
   * Refreshes an access token.
   *
   * Providers differ: X exchanges a refresh token; Instagram re-issues from the
   * current long-lived token; LinkedIn generally cannot refresh at all. The
   * provider-specific behaviour lives in the adapters, and a provider that
   * cannot refresh raises UnsupportedCapabilityError, which is recorded on the
   * connection so the UI can prompt for reconnection.
   */
  async refresh(connectionId: string): Promise<{ refreshed: boolean; reason?: string }> {
    const connection = await this.prisma.socialConnection.findUnique({
      where: { id: connectionId },
      select: connectionSecretsSelect,
    });
    if (!connection) throw new NotFoundError('Social connection');

    const adapter = this.registry.getConfigured(connection.provider);
    const tokens = this.decryptTokens(connection);

    try {
      // Instagram refreshes using the access token itself; the others use the
      // refresh token.
      const credential =
        connection.provider === 'INSTAGRAM' ? tokens.accessToken : (tokens.refreshToken ?? '');

      const refreshed = await adapter.refreshToken(credential);

      await this.prisma.socialConnection.update({
        where: { id: connectionId },
        data: {
          accessTokenEncrypted: this.secrets.encrypt(refreshed.accessToken),
          ...(refreshed.refreshToken
            ? { refreshTokenEncrypted: this.secrets.encrypt(refreshed.refreshToken) }
            : {}),
          expiresAt: refreshed.expiresAt ?? null,
          ...(refreshed.scopes.length > 0 ? { scopes: refreshed.scopes } : {}),
          status: 'ACTIVE',
          lastValidatedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      return { refreshed: true };
    } catch (error) {
      const reason =
        error instanceof UnsupportedCapabilityError
          ? error.requirement
          : error instanceof Error
            ? error.message
            : 'Token refresh failed.';

      await this.prisma.socialConnection.update({
        where: { id: connectionId },
        data: {
          status: 'EXPIRED',
          lastErrorCode: 'REFRESH_FAILED',
          lastErrorMessage: reason.slice(0, 1_000),
        },
      });

      this.logger.warn({
        message: 'Token refresh failed.',
        connectionId,
        provider: connection.provider,
        reason,
      });

      return { refreshed: false, reason };
    }
  }

  async disconnect(auth: AuthContext, connectionId: string): Promise<void> {
    const connection = await this.requireConnection(auth, connectionId);

    // Provider-side revocation is attempted, but the local record is removed
    // regardless: a user disconnecting must always succeed locally.
    try {
      const adapter = this.registry.get(connection.provider);
      if (adapter.configured) {
        await adapter.disconnect(this.decryptTokens(connection));
      }
    } catch (error) {
      this.logger.warn({
        message: 'Provider-side revocation failed; removing the local connection anyway.',
        connectionId,
        provider: connection.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.prisma.socialConnection.delete({ where: { id: connectionId } });
  }

  /** Removes expired, unconsumed OAuth states. Called by the worker's cleanup job. */
  async purgeExpiredStates(): Promise<number> {
    const result = await this.prisma.oAuthState.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }

  private async requireConnection(auth: AuthContext, connectionId: string) {
    const connection = await this.prisma.socialConnection.findUnique({
      where: { id: connectionId },
      select: connectionSecretsSelect,
    });
    if (!connection || connection.organizationId !== auth.organizationId) {
      throw new NotFoundError('Social connection');
    }
    return connection;
  }

  /** The only place stored tokens are decrypted. Never returned to a caller. */
  private decryptTokens(connection: {
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string | null;
    expiresAt: Date | null;
    scopes: string[];
  }): TokenSet {
    return {
      accessToken: this.secrets.decrypt(connection.accessTokenEncrypted),
      ...(connection.refreshTokenEncrypted
        ? { refreshToken: this.secrets.decrypt(connection.refreshTokenEncrypted) }
        : {}),
      ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}),
      scopes: connection.scopes,
    };
  }
}

const connectionSecretsSelect = {
  id: true,
  organizationId: true,
  provider: true,
  providerAccountId: true,
  accessTokenEncrypted: true,
  refreshTokenEncrypted: true,
  expiresAt: true,
  scopes: true,
} as const;

/**
 * Restricts a post-connection redirect to a same-site absolute path.
 * Prevents the OAuth callback from being turned into an open redirect.
 */
export function sanitizeRedirectPath(path: string | undefined): string | null {
  if (!path) return null;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (path.includes('\\') || /[\r\n]/.test(path)) return null;
  return path.slice(0, 500);
}

export type { SocialProviderAdapter };
