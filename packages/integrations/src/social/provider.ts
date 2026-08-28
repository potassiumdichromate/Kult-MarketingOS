import type { ContentType, SocialProvider as ProviderName } from '@kult/shared';

/**
 * The contract every social provider adapter implements.
 *
 * Design rule: a method exists here only if at least one provider can genuinely
 * perform it against its current official API. Where a specific provider cannot,
 * the adapter throws UnsupportedCapabilityError carrying the exact external
 * requirement - it never returns a fabricated success.
 */

export interface AuthorizationRequest {
  /** Fully-formed URL to redirect the member's browser to. */
  url: string;
  /** Opaque CSRF state to persist and re-check on callback. */
  state: string;
  /** PKCE verifier to persist (encrypted) when the provider uses PKCE. */
  codeVerifier?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry. Undefined when the provider issues non-expiring tokens. */
  expiresAt?: Date;
  scopes: string[];
}

export interface ProviderAccount {
  providerAccountId: string;
  accountName: string;
  accountUsername?: string;
  /** Non-secret provider detail: account type, page ids, eligibility findings. */
  metadata: Record<string, unknown>;
}

/**
 * What this connection can actually do right now, derived from granted scopes
 * and account eligibility. Rendered directly in the integrations UI so an
 * operator sees the truth rather than an optimistic list.
 */
export interface ConnectionCapabilities {
  /** Content types this connection can publish today. */
  publishableContentTypes: ContentType[];
  /** Capability name -> why it is unavailable. */
  unavailable: Record<string, string>;
  /** Scopes the provider actually granted. */
  grantedScopes: string[];
  /** Scopes we asked for but did not receive. */
  missingScopes: string[];
  canReadMetrics: boolean;
}

export interface ValidationResult {
  valid: boolean;
  account?: ProviderAccount;
  capabilities?: ConnectionCapabilities;
  /** Present when invalid: operator-facing explanation. */
  reason?: string;
  /** True when re-authorization by a human is the only remedy. */
  requiresReauthorization?: boolean;
}

export interface PublishInput {
  contentType: ContentType;
  body: string;
  /** Ordered post bodies for multi-post formats (X threads). */
  threadParts?: string[];
  hashtags?: string[];
  /**
   * Media to attach. `publicUrl` is required by providers that build containers
   * from a URL (Instagram); `buffer` is required by providers that accept a
   * binary upload (X, LinkedIn).
   */
  media?: Array<{
    publicUrl?: string;
    buffer?: Buffer;
    mimeType: string;
    altText?: string;
  }>;
  /** Idempotency key, forwarded to providers that honour one. */
  idempotencyKey: string;
}

export interface PublishResult {
  providerPostId: string;
  /** Every provider id produced, in order. Multi-post threads yield several. */
  providerPostIds: string[];
  url?: string;
  publishedAt: Date;
  /** Non-secret response metadata: rate-limit headers, container ids. */
  metadata: Record<string, unknown>;
}

export interface PostMetrics {
  providerPostId: string;
  capturedAt: Date;
  /** Undefined means the provider did not return that metric. Never zero-filled. */
  impressions?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  reposts?: number;
  saves?: number;
  clicks?: number;
  videoViews?: number;
  raw: Record<string, unknown>;
}

export interface MediaUploadResult {
  /** Provider-side media identifier to attach to a post. */
  mediaId: string;
  metadata: Record<string, unknown>;
}

export interface SocialProviderAdapter {
  readonly name: ProviderName;
  /** False when this deployment lacks the provider's credentials. */
  readonly configured: boolean;
  /** Scopes this adapter requests at authorization time. */
  readonly requestedScopes: string[];

  getAuthorizationUrl(input: { state: string; codeVerifier?: string }): AuthorizationRequest;

  handleOAuthCallback(input: { code: string; codeVerifier?: string }): Promise<TokenSet>;

  /**
   * Exchanges a refresh token for a fresh access token.
   * Providers without programmatic refresh throw UnsupportedCapabilityError so
   * the caller marks the connection EXPIRED and prompts for re-authorization.
   */
  refreshToken(refreshToken: string): Promise<TokenSet>;

  getAccount(tokens: TokenSet): Promise<ProviderAccount>;

  /** Resolves what the connection can do, from granted scopes and account state. */
  resolveCapabilities(input: {
    tokens: TokenSet;
    account: ProviderAccount;
  }): Promise<ConnectionCapabilities>;

  validateConnection(tokens: TokenSet): Promise<ValidationResult>;

  createMediaUpload?(input: {
    tokens: TokenSet;
    account: ProviderAccount;
    buffer?: Buffer;
    publicUrl?: string;
    mimeType: string;
    altText?: string;
  }): Promise<MediaUploadResult>;

  createPost(input: {
    tokens: TokenSet;
    account: ProviderAccount;
    post: PublishInput;
  }): Promise<PublishResult>;

  getPost(input: { tokens: TokenSet; providerPostId: string }): Promise<Record<string, unknown>>;

  getMetrics(input: {
    tokens: TokenSet;
    account: ProviderAccount;
    providerPostId: string;
  }): Promise<PostMetrics>;

  /** Best-effort provider-side revocation. Local deletion happens regardless. */
  disconnect(tokens: TokenSet): Promise<void>;
}
