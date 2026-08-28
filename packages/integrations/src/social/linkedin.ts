import type { LinkedInConfig } from '@kult/config';
import {
  NotConfiguredError,
  ProviderError,
  UnsupportedCapabilityError,
  type ContentType,
} from '@kult/shared';
import { providerRequest } from './http.js';
import type {
  AuthorizationRequest,
  ConnectionCapabilities,
  PostMetrics,
  ProviderAccount,
  PublishInput,
  PublishResult,
  SocialProviderAdapter,
  TokenSet,
  ValidationResult,
} from './provider.js';

/**
 * LinkedIn provider - member posting.
 *
 * Verified against the current official LinkedIn documentation (2026-08):
 *   authorize   GET  https://www.linkedin.com/oauth/v2/authorization
 *   token       POST https://www.linkedin.com/oauth/v2/accessToken
 *   userinfo    GET  https://api.linkedin.com/v2/userinfo        (OpenID Connect)
 *   create post POST https://api.linkedin.com/rest/posts
 *                    headers: LinkedIn-Version: YYYYMM, X-Restli-Protocol-Version: 2.0.0
 *                    201 response returns the post URN in the x-restli-id header
 *
 * Three limitations are surfaced rather than worked around:
 *
 *  1. Refresh tokens. LinkedIn states that programmatic refresh tokens are
 *     available only to a limited set of partners. If the token response omits
 *     one, `refreshToken()` raises UNSUPPORTED_CAPABILITY and the connection is
 *     marked EXPIRED so a human re-authorizes. Access tokens last 60 days.
 *
 *  2. Organization (company page) posting needs `w_organization_social`, which
 *     requires additional LinkedIn product access. Capability resolution reports
 *     that requirement instead of attempting an organization post.
 *
 *  3. Reading a member's own posts needs `r_member_social`, which LinkedIn
 *     documents as restricted to approved applications. Without it, per-post
 *     metrics are unavailable, and this adapter says so rather than inventing
 *     numbers.
 */

const AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const API_BASE = 'https://api.linkedin.com';

interface LinkedInTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

interface UserInfoResponse {
  sub?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  picture?: string;
}

export class LinkedInProvider implements SocialProviderAdapter {
  readonly name = 'LINKEDIN' as const;
  readonly configured: boolean;
  /**
   * openid/profile/email identify the member (to build urn:li:person:{sub});
   * w_member_social authorises posting on their behalf.
   */
  readonly requestedScopes = ['openid', 'profile', 'email', 'w_member_social'];

  constructor(private readonly config: LinkedInConfig | undefined) {
    this.configured = Boolean(config);
  }

  private requireConfig(): LinkedInConfig {
    if (!this.config) {
      throw new NotConfiguredError('The LinkedIn integration', [
        'LINKEDIN_CLIENT_ID',
        'LINKEDIN_CLIENT_SECRET',
        'LINKEDIN_REDIRECT_URI',
      ]);
    }
    return this.config;
  }

  private restHeaders(accessToken: string): Record<string, string> {
    const config = this.requireConfig();
    return {
      authorization: `Bearer ${accessToken}`,
      'linkedin-version': config.apiVersion,
      'x-restli-protocol-version': '2.0.0',
      'content-type': 'application/json',
    };
  }

  getAuthorizationUrl(input: { state: string }): AuthorizationRequest {
    const config = this.requireConfig();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', this.requestedScopes.join(' '));
    return { url: url.toString(), state: input.state };
  }

  async handleOAuthCallback(input: { code: string }): Promise<TokenSet> {
    const config = this.requireConfig();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    });

    const { data } = await providerRequest<LinkedInTokenResponse>({
      provider: 'LinkedIn',
      url: TOKEN_URL,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    return {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      ...(data.expires_in ? { expiresAt: new Date(Date.now() + data.expires_in * 1000) } : {}),
      scopes: data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : this.requestedScopes,
    };
  }

  /**
   * Only usable when LinkedIn issued a refresh token, which it does for
   * approved partner applications. Otherwise this reports the requirement and
   * the caller prompts for re-authorization.
   */
  async refreshToken(refreshToken: string): Promise<TokenSet> {
    const config = this.requireConfig();
    if (!refreshToken) {
      throw new UnsupportedCapabilityError(
        'LinkedIn',
        'token refresh',
        'LinkedIn issued no refresh token for this connection. Programmatic refresh tokens are ' +
          'available only to approved LinkedIn partner applications. The member must reconnect ' +
          'their LinkedIn account when the 60-day access token expires.',
      );
    }

    const { data } = await providerRequest<LinkedInTokenResponse>({
      provider: 'LinkedIn',
      url: TOKEN_URL,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    return {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      ...(data.expires_in ? { expiresAt: new Date(Date.now() + data.expires_in * 1000) } : {}),
      scopes: data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : [],
    };
  }

  async getAccount(tokens: TokenSet): Promise<ProviderAccount> {
    const { data } = await providerRequest<UserInfoResponse>({
      provider: 'LinkedIn',
      url: `${API_BASE}/v2/userinfo`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    if (!data.sub) {
      throw new ProviderError('LinkedIn', 'LinkedIn did not return a member identifier.', {
        retryable: false,
      });
    }

    const name =
      data.name ?? [data.given_name, data.family_name].filter(Boolean).join(' ') ?? data.sub;

    return {
      providerAccountId: data.sub,
      accountName: name,
      metadata: {
        personUrn: `urn:li:person:${data.sub}`,
        email: data.email ?? null,
        pictureUrl: data.picture ?? null,
        authorType: 'MEMBER',
      },
    };
  }

  async resolveCapabilities(input: { tokens: TokenSet }): Promise<ConnectionCapabilities> {
    const granted = new Set(input.tokens.scopes);
    const missing = this.requestedScopes.filter((scope) => !granted.has(scope));
    const unavailable: Record<string, string> = {};

    const canPostAsMember = granted.has('w_member_social');
    const publishable: ContentType[] = canPostAsMember ? ['LINKEDIN_POST', 'LINKEDIN_ARTICLE'] : [];

    if (!canPostAsMember) {
      unavailable.publish =
        'The "w_member_social" permission was not granted. Reconnect the account and approve ' +
        'posting on your behalf.';
    }

    unavailable.organizationPosting =
      'Posting to a LinkedIn company page requires the "w_organization_social" permission, which ' +
      'needs additional LinkedIn API product access (Community Management API) approved for this ' +
      'application, plus an ADMINISTRATOR, CONTENT_ADMIN, or DIRECT_SPONSORED_CONTENT_POSTER role ' +
      'on the page. Additional LinkedIn API access is required.';

    const canReadOwnPosts = granted.has('r_member_social');
    if (!canReadOwnPosts) {
      unavailable.metrics =
        'Per-post metrics require the "r_member_social" permission, which LinkedIn restricts to ' +
        'approved applications. Published posts are tracked, but LinkedIn engagement figures ' +
        'cannot be retrieved without that access.';
    }

    if (!input.tokens.refreshToken) {
      unavailable.tokenRefresh =
        'LinkedIn issued no refresh token. Programmatic refresh is limited to approved LinkedIn ' +
        'partners, so this connection must be renewed manually before the 60-day access token expires.';
    }

    unavailable.organicCarousel =
      'LinkedIn supports carousel posts for sponsored content only; organic carousels are not ' +
      'available through the Posts API.';

    return {
      publishableContentTypes: publishable,
      unavailable,
      grantedScopes: [...granted],
      missingScopes: missing,
      canReadMetrics: canReadOwnPosts,
    };
  }

  async validateConnection(tokens: TokenSet): Promise<ValidationResult> {
    try {
      const account = await this.getAccount(tokens);
      const capabilities = await this.resolveCapabilities({ tokens });
      return { valid: true, account, capabilities };
    } catch (error) {
      const status = error instanceof ProviderError ? error.providerStatus : undefined;
      return {
        valid: false,
        reason:
          error instanceof Error ? error.message : 'The LinkedIn connection could not be validated.',
        requiresReauthorization: status === 401 || status === 403,
      };
    }
  }

  async createPost(input: {
    tokens: TokenSet;
    account: ProviderAccount;
    post: PublishInput;
  }): Promise<PublishResult> {
    const { tokens, account, post } = input;

    if (post.contentType !== 'LINKEDIN_POST' && post.contentType !== 'LINKEDIN_ARTICLE') {
      throw new UnsupportedCapabilityError(
        'LinkedIn',
        post.contentType,
        'The LinkedIn provider publishes LINKEDIN_POST and LINKEDIN_ARTICLE only.',
      );
    }
    if (!tokens.scopes.includes('w_member_social')) {
      throw new UnsupportedCapabilityError(
        'LinkedIn',
        'member posting',
        'The "w_member_social" permission was not granted for this connection.',
      );
    }
    if ((post.media ?? []).length > 0) {
      // Attaching media requires uploading through the Images/Videos API to obtain
      // an asset URN. That flow is not implemented, and silently dropping the
      // media would publish something other than what was approved.
      throw new UnsupportedCapabilityError(
        'LinkedIn',
        'media attachments',
        'Publishing media to LinkedIn requires uploading the asset through the LinkedIn Images or ' +
          'Videos API to obtain an asset URN. This integration publishes text posts only. Remove ' +
          'the media, or publish this content to a platform that supports it.',
      );
    }

    const authorUrn =
      typeof account.metadata.personUrn === 'string'
        ? account.metadata.personUrn
        : `urn:li:person:${account.providerAccountId}`;

    const commentary = buildCommentary(post);

    const response = await providerRequest<unknown>({
      provider: 'LinkedIn',
      url: `${API_BASE}/rest/posts`,
      method: 'POST',
      headers: this.restHeaders(tokens.accessToken),
      body: JSON.stringify({
        author: authorUrn,
        commentary,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      }),
      expectStatuses: [201],
    });

    // LinkedIn returns the created post's URN in the x-restli-id response header,
    // not in the body.
    const postUrn = response.headers['x-restli-id'];
    if (!postUrn) {
      throw new ProviderError(
        'LinkedIn',
        'LinkedIn accepted the post but returned no x-restli-id header, so the post URN is unknown.',
        { providerStatus: response.status, retryable: false },
      );
    }

    return {
      providerPostId: postUrn,
      providerPostIds: [postUrn],
      url: `https://www.linkedin.com/feed/update/${postUrn}/`,
      publishedAt: new Date(),
      metadata: { author: authorUrn, apiVersion: this.requireConfig().apiVersion },
    };
  }

  async getPost(input: {
    tokens: TokenSet;
    providerPostId: string;
  }): Promise<Record<string, unknown>> {
    const { data } = await providerRequest<Record<string, unknown>>({
      provider: 'LinkedIn',
      url: `${API_BASE}/rest/posts/${encodeURIComponent(input.providerPostId)}`,
      headers: this.restHeaders(input.tokens.accessToken),
    });
    return data;
  }

  /**
   * LinkedIn does not expose per-post engagement metrics to applications holding
   * only `w_member_social`. Rather than return fabricated zeros, this states the
   * exact access required.
   */
  async getMetrics(input: { tokens: TokenSet }): Promise<PostMetrics> {
    void input;
    throw new UnsupportedCapabilityError(
      'LinkedIn',
      'post metrics',
      'Retrieving engagement metrics for a member post requires the "r_member_social" permission, ' +
        'which LinkedIn grants only to approved applications. Request that access in the LinkedIn ' +
        'Developer Portal to enable LinkedIn analytics.',
    );
  }

  /**
   * LinkedIn provides no OAuth revocation endpoint for member tokens. The local
   * connection is removed; the member can revoke access from LinkedIn settings.
   */
  async disconnect(): Promise<void> {
    return;
  }
}

function buildCommentary(post: PublishInput): string {
  const hashtags = (post.hashtags ?? []).map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
  return hashtags.length > 0 ? `${post.body}\n\n${hashtags.join(' ')}` : post.body;
}
