import { PrivyClient } from '@privy-io/server-auth';
import type { AppConfig } from '@kult/config';
import { InvalidCredentialsError } from '@kult/shared';

/**
 * Server-side Privy identity verification.
 *
 * The browser never tells us who it is. It presents a Privy access token; this
 * module verifies that token's signature and claims with the official server SDK
 * and returns the Privy DID. Every authenticated request derives its identity
 * from here and nowhere else.
 *
 * Verified against @privy-io/server-auth 1.32:
 *   new PrivyClient(appId, appSecret)
 *   client.verifyAuthToken(token, verificationKeyOverride?) -> AuthTokenClaims
 *   client.getUser({ idToken })                             -> User
 */

export interface VerifiedIdentity {
  privyUserId: string;
  sessionId: string;
  appId: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface PrivyProfile {
  privyUserId: string;
  email?: string;
  walletAddress?: string;
  displayName?: string;
}

export class PrivyAuthenticator {
  private readonly client: PrivyClient;
  private readonly verificationKey?: string;
  private readonly expectedAppId: string;

  constructor(config: Pick<AppConfig, 'privy'>) {
    this.client = new PrivyClient(config.privy.appId, config.privy.appSecret);
    this.expectedAppId = config.privy.appId;
    if (config.privy.verificationKey) this.verificationKey = config.privy.verificationKey;
  }

  /**
   * Verifies a Privy access token.
   *
   * Supplying PRIVY_VERIFICATION_KEY makes this fully offline (no network call
   * per request); without it the SDK fetches and caches the JWKS itself.
   */
  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    if (!token || token.trim().length === 0) {
      throw new InvalidCredentialsError('An access token is required.');
    }

    let claims;
    try {
      claims = this.verificationKey
        ? await this.client.verifyAuthToken(token, this.verificationKey)
        : await this.client.verifyAuthToken(token);
    } catch (error) {
      // The SDK's message can describe why the token failed; that detail is for
      // operators, not for the caller.
      throw new InvalidCredentialsError('The access token is invalid or has expired.', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    // Defence in depth: reject a validly-signed token minted for another Privy app.
    if (claims.appId !== this.expectedAppId) {
      throw new InvalidCredentialsError('The access token was issued for a different application.', {
        tokenAppId: claims.appId,
      });
    }

    return {
      privyUserId: claims.userId,
      sessionId: claims.sessionId,
      appId: claims.appId,
      issuedAt: new Date(claims.issuedAt * 1000),
      expiresAt: new Date(claims.expiration * 1000),
    };
  }

  /**
   * Loads the linked-account profile used to populate the local User row.
   *
   * Prefers the identity-token path, which the SDK documents as the
   * rate-limit-friendly option. Profile enrichment is best-effort: a failure
   * here must not block an otherwise valid session, so callers receive
   * `undefined` and fall back to the DID alone.
   */
  async getProfile(idToken: string): Promise<PrivyProfile | undefined> {
    try {
      const user = await this.client.getUser({ idToken });
      const profile: PrivyProfile = { privyUserId: user.id };
      if (user.email?.address) profile.email = user.email.address;
      if (user.wallet?.address) profile.walletAddress = user.wallet.address;

      const displayName =
        user.google?.name ??
        user.twitter?.name ??
        user.github?.name ??
        user.discord?.username ??
        user.email?.address ??
        undefined;
      if (displayName) profile.displayName = displayName;

      return profile;
    } catch {
      return undefined;
    }
  }
}

/** Extracts a bearer token from an Authorization header value. */
export function bearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1]?.trim() ?? null;
}
