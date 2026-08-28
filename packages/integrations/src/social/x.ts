import { createHash } from 'node:crypto';
import type { XConfig } from '@kult/config';
import {
  NotConfiguredError,
  UnsupportedCapabilityError,
  ProviderError,
  type ContentType,
} from '@kult/shared';
import { basicAuthHeader, providerRequest } from './http.js';
import type {
  AuthorizationRequest,
  ConnectionCapabilities,
  MediaUploadResult,
  PostMetrics,
  ProviderAccount,
  PublishInput,
  PublishResult,
  SocialProviderAdapter,
  TokenSet,
  ValidationResult,
} from './provider.js';

/**
 * X (Twitter) provider.
 *
 * Verified against the current official X API documentation (2026-08):
 *   authorize     GET  https://x.com/i/oauth2/authorize      (OAuth 2.0 + PKCE)
 *   token         POST https://api.x.com/2/oauth2/token
 *   revoke        POST https://api.x.com/2/oauth2/revoke
 *   me            GET  https://api.x.com/2/users/me
 *   create post   POST https://api.x.com/2/tweets
 *   read post     GET  https://api.x.com/2/tweets/:id
 *   media upload  POST https://api.x.com/2/media/upload      (INIT/APPEND/FINALIZE)
 *
 * Scopes used: tweet.read, tweet.write, users.read, offline.access, media.write.
 * `offline.access` is what makes a refresh token available; access tokens expire
 * after two hours.
 *
 * Deliberately not implemented: quote posts. The documentation states
 * `quote_tweet_id` requires an Enterprise plan, so the adapter reports it as an
 * unsupported capability rather than attempting a call that would fail.
 */

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const REVOKE_URL = 'https://api.x.com/2/oauth2/revoke';
const API_BASE = 'https://api.x.com/2';
const MEDIA_UPLOAD_URL = 'https://api.x.com/2/media/upload';

/** APPEND chunk size. X accepts up to 5 MB per chunk; 4 MB leaves headroom. */
const CHUNK_BYTES = 4 * 1024 * 1024;

interface XTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface XUserResponse {
  data?: {
    id: string;
    name: string;
    username: string;
    profile_image_url?: string;
    verified?: boolean;
  };
}

interface XCreateTweetResponse {
  data?: { id: string; text: string };
}

interface XTweetLookupResponse {
  data?: {
    id: string;
    text?: string;
    created_at?: string;
    public_metrics?: {
      retweet_count?: number;
      reply_count?: number;
      like_count?: number;
      quote_count?: number;
      bookmark_count?: number;
      impression_count?: number;
    };
  };
}

export class XProvider implements SocialProviderAdapter {
  readonly name = 'X' as const;
  readonly configured: boolean;
  readonly requestedScopes = [
    'tweet.read',
    'tweet.write',
    'users.read',
    'media.write',
    'offline.access',
  ];

  constructor(private readonly config: XConfig | undefined) {
    this.configured = Boolean(config);
  }

  private requireConfig(): XConfig {
    if (!this.config) {
      throw new NotConfiguredError('The X integration', [
        'X_CLIENT_ID',
        'X_CLIENT_SECRET',
        'X_REDIRECT_URI',
      ]);
    }
    return this.config;
  }

  getAuthorizationUrl(input: { state: string; codeVerifier?: string }): AuthorizationRequest {
    const config = this.requireConfig();
    if (!input.codeVerifier) {
      throw new Error('X authorization requires a PKCE code verifier.');
    }
    // The challenge is derived by the caller's PKCE helper; recompute here so the
    // adapter never depends on the caller having done it correctly.
    const codeChallenge = createS256Challenge(input.codeVerifier);

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('scope', this.requestedScopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return { url: url.toString(), state: input.state, codeVerifier: input.codeVerifier };
  }

  async handleOAuthCallback(input: { code: string; codeVerifier?: string }): Promise<TokenSet> {
    const config = this.requireConfig();
    if (!input.codeVerifier) {
      throw new ProviderError('X', 'The PKCE code verifier is missing for this authorization.', {
        retryable: false,
      });
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: config.redirectUri,
      code_verifier: input.codeVerifier,
      // Documented as required even for confidential clients.
      client_id: config.clientId,
    });

    const { data } = await providerRequest<XTokenResponse>({
      provider: 'X',
      url: TOKEN_URL,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicAuthHeader(config.clientId, config.clientSecret),
      },
      body,
    });

    return toTokenSet(data);
  }

  async refreshToken(refreshToken: string): Promise<TokenSet> {
    const config = this.requireConfig();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
    });

    const { data } = await providerRequest<XTokenResponse>({
      provider: 'X',
      url: TOKEN_URL,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicAuthHeader(config.clientId, config.clientSecret),
      },
      body,
    });

    return toTokenSet(data);
  }

  async getAccount(tokens: TokenSet): Promise<ProviderAccount> {
    const { data } = await providerRequest<XUserResponse>({
      provider: 'X',
      url: `${API_BASE}/users/me?user.fields=profile_image_url,verified,username,name`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    const user = data.data;
    if (!user) {
      throw new ProviderError('X', 'X did not return an account for this token.', {
        retryable: false,
      });
    }

    return {
      providerAccountId: user.id,
      accountName: user.name,
      accountUsername: user.username,
      metadata: {
        profileImageUrl: user.profile_image_url ?? null,
        verified: user.verified ?? null,
      },
    };
  }

  async resolveCapabilities(input: { tokens: TokenSet }): Promise<ConnectionCapabilities> {
    const granted = new Set(input.tokens.scopes);
    const missing = this.requestedScopes.filter((scope) => !granted.has(scope));

    const canWrite = granted.has('tweet.write');
    const canUploadMedia = granted.has('media.write');

    const publishable: ContentType[] = canWrite ? ['X_POST', 'X_THREAD'] : [];

    const unavailable: Record<string, string> = {};
    if (!canWrite) {
      unavailable.publish =
        'The "tweet.write" scope was not granted. Reconnect the account and approve posting access.';
    }
    if (!canUploadMedia) {
      unavailable.mediaUpload =
        'The "media.write" scope was not granted, so images and video cannot be attached. ' +
        'Text-only posts still publish.';
    }
    if (!granted.has('offline.access')) {
      unavailable.tokenRefresh =
        'The "offline.access" scope was not granted, so the two-hour access token cannot be ' +
        'refreshed automatically. The account will need periodic reconnection.';
    }
    unavailable.quotePost =
      'Quote posting requires an X Enterprise plan (the quote_tweet_id parameter is Enterprise-only).';

    return {
      publishableContentTypes: publishable,
      unavailable,
      grantedScopes: [...granted],
      missingScopes: missing,
      canReadMetrics: granted.has('tweet.read'),
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
          error instanceof Error ? error.message : 'The X connection could not be validated.',
        requiresReauthorization: status === 401 || status === 403,
      };
    }
  }

  /**
   * Chunked media upload: INIT -> APPEND(n) -> FINALIZE -> STATUS (when the
   * FINALIZE response reports asynchronous processing).
   */
  async createMediaUpload(input: {
    tokens: TokenSet;
    buffer?: Buffer;
    mimeType: string;
  }): Promise<MediaUploadResult> {
    if (!input.buffer) {
      throw new ProviderError('X', 'X media upload requires the media bytes.', { retryable: false });
    }
    if (!input.tokens.scopes.includes('media.write')) {
      throw new UnsupportedCapabilityError(
        'X',
        'media upload',
        'The connected X account did not grant the "media.write" scope. Reconnect the account and approve media access.',
      );
    }

    const auth = { authorization: `Bearer ${input.tokens.accessToken}` };
    const category = input.mimeType.startsWith('video/')
      ? 'tweet_video'
      : input.mimeType === 'image/gif'
        ? 'tweet_gif'
        : 'tweet_image';

    const initBody = new URLSearchParams({
      command: 'INIT',
      media_type: input.mimeType,
      total_bytes: String(input.buffer.byteLength),
      media_category: category,
    });
    const init = await providerRequest<{ data?: { id?: string }; media_id_string?: string }>({
      provider: 'X',
      url: MEDIA_UPLOAD_URL,
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: initBody,
    });

    const mediaId = init.data.data?.id ?? init.data.media_id_string;
    if (!mediaId) {
      throw new ProviderError('X', 'X did not return a media id from INIT.', { retryable: true });
    }

    for (let offset = 0, segment = 0; offset < input.buffer.byteLength; segment += 1) {
      const chunk = input.buffer.subarray(offset, offset + CHUNK_BYTES);
      const form = new FormData();
      form.set('command', 'APPEND');
      form.set('media_id', mediaId);
      form.set('segment_index', String(segment));
      form.set('media', new Blob([chunk], { type: input.mimeType }));

      await providerRequest<unknown>({
        provider: 'X',
        url: MEDIA_UPLOAD_URL,
        method: 'POST',
        headers: auth,
        body: form,
        // APPEND returns 204 No Content on success.
        expectStatuses: [200, 201, 204],
        timeoutMs: 120_000,
      });
      offset += CHUNK_BYTES;
    }

    const finalize = await providerRequest<{
      data?: { id?: string; processing_info?: { state?: string; check_after_secs?: number } };
      processing_info?: { state?: string; check_after_secs?: number };
    }>({
      provider: 'X',
      url: MEDIA_UPLOAD_URL,
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ command: 'FINALIZE', media_id: mediaId }),
    });

    const processing = finalize.data.data?.processing_info ?? finalize.data.processing_info;
    if (processing?.state && processing.state !== 'succeeded') {
      await this.awaitMediaProcessing(input.tokens, mediaId, processing.check_after_secs ?? 2);
    }

    return { mediaId, metadata: { mediaCategory: category } };
  }

  private async awaitMediaProcessing(
    tokens: TokenSet,
    mediaId: string,
    firstDelaySeconds: number,
  ): Promise<void> {
    let delaySeconds = Math.max(1, firstDelaySeconds);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(delaySeconds * 1000);
      const { data } = await providerRequest<{
        data?: { processing_info?: { state?: string; check_after_secs?: number; error?: unknown } };
        processing_info?: { state?: string; check_after_secs?: number; error?: unknown };
      }>({
        provider: 'X',
        url: `${MEDIA_UPLOAD_URL}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });

      const info = data.data?.processing_info ?? data.processing_info;
      if (!info || info.state === 'succeeded') return;
      if (info.state === 'failed') {
        throw new ProviderError('X', 'X failed to process the uploaded media.', {
          retryable: false,
        });
      }
      delaySeconds = Math.max(1, info.check_after_secs ?? delaySeconds);
    }

    throw new ProviderError('X', 'X media processing did not complete in time.', {
      retryable: true,
    });
  }

  async createPost(input: {
    tokens: TokenSet;
    account: ProviderAccount;
    post: PublishInput;
  }): Promise<PublishResult> {
    const { tokens, account, post } = input;

    if (post.contentType !== 'X_POST' && post.contentType !== 'X_THREAD') {
      throw new UnsupportedCapabilityError(
        'X',
        post.contentType,
        'The X provider publishes X_POST and X_THREAD only.',
      );
    }

    // Media is uploaded once and attached to the first post of a thread.
    const mediaIds: string[] = [];
    for (const media of post.media ?? []) {
      const uploaded = await this.createMediaUpload({
        tokens,
        ...(media.buffer ? { buffer: media.buffer } : {}),
        mimeType: media.mimeType,
      });
      mediaIds.push(uploaded.mediaId);
    }

    const parts =
      post.contentType === 'X_THREAD' && post.threadParts && post.threadParts.length > 0
        ? post.threadParts
        : [post.body];

    const postedIds: string[] = [];
    let replyTo: string | undefined;

    for (const [index, text] of parts.entries()) {
      const payload: Record<string, unknown> = { text };
      if (index === 0 && mediaIds.length > 0) payload.media = { media_ids: mediaIds };
      if (replyTo) payload.reply = { in_reply_to_tweet_id: replyTo };

      try {
        const { data } = await providerRequest<XCreateTweetResponse>({
          provider: 'X',
          url: `${API_BASE}/tweets`,
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokens.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const id = data.data?.id;
        if (!id) {
          throw new ProviderError('X', 'X did not return a post id.', { retryable: true });
        }
        postedIds.push(id);
        replyTo = id;
      } catch (error) {
        // A thread that fails midway has genuinely published its earlier posts.
        // Surfacing the ids lets the worker record reality rather than pretend
        // nothing happened.
        if (postedIds.length > 0 && error instanceof ProviderError) {
          throw new ProviderError(
            'X',
            `${error.message} ${postedIds.length} of ${parts.length} posts in the thread were published before the failure.`,
            {
              ...(error.providerStatus !== undefined
                ? { providerStatus: error.providerStatus }
                : {}),
              retryable: false,
              details: { publishedPostIds: postedIds },
            },
          );
        }
        throw error;
      }
    }

    const firstId = postedIds[0];
    if (!firstId) {
      throw new ProviderError('X', 'No posts were created.', { retryable: true });
    }

    return {
      providerPostId: firstId,
      providerPostIds: postedIds,
      url: account.accountUsername
        ? `https://x.com/${account.accountUsername}/status/${firstId}`
        : `https://x.com/i/status/${firstId}`,
      publishedAt: new Date(),
      metadata: { partCount: postedIds.length, mediaIds },
    };
  }

  async getPost(input: { tokens: TokenSet; providerPostId: string }): Promise<Record<string, unknown>> {
    const { data } = await providerRequest<XTweetLookupResponse>({
      provider: 'X',
      url: `${API_BASE}/tweets/${encodeURIComponent(input.providerPostId)}?tweet.fields=created_at,public_metrics`,
      headers: { authorization: `Bearer ${input.tokens.accessToken}` },
    });
    return (data.data ?? {}) as Record<string, unknown>;
  }

  /**
   * Reads the metrics X exposes on `public_metrics`.
   *
   * `non_public_metrics` and `organic_metrics` are deliberately not requested:
   * they are gated behind access levels this application cannot assume, and a
   * request for them fails outright rather than degrading.
   */
  async getMetrics(input: {
    tokens: TokenSet;
    providerPostId: string;
  }): Promise<PostMetrics> {
    const { data } = await providerRequest<XTweetLookupResponse>({
      provider: 'X',
      url: `${API_BASE}/tweets/${encodeURIComponent(input.providerPostId)}?tweet.fields=public_metrics`,
      headers: { authorization: `Bearer ${input.tokens.accessToken}` },
    });

    const metrics = data.data?.public_metrics ?? {};
    return {
      providerPostId: input.providerPostId,
      capturedAt: new Date(),
      ...(metrics.impression_count !== undefined ? { impressions: metrics.impression_count } : {}),
      ...(metrics.like_count !== undefined ? { likes: metrics.like_count } : {}),
      ...(metrics.reply_count !== undefined ? { comments: metrics.reply_count } : {}),
      ...(metrics.retweet_count !== undefined ? { reposts: metrics.retweet_count } : {}),
      ...(metrics.bookmark_count !== undefined ? { saves: metrics.bookmark_count } : {}),
      raw: metrics as Record<string, unknown>,
    };
  }

  async disconnect(tokens: TokenSet): Promise<void> {
    const config = this.requireConfig();
    try {
      await providerRequest<unknown>({
        provider: 'X',
        url: REVOKE_URL,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basicAuthHeader(config.clientId, config.clientSecret),
        },
        body: new URLSearchParams({
          token: tokens.accessToken,
          token_type_hint: 'access_token',
          client_id: config.clientId,
        }),
      });
    } catch {
      // Provider-side revocation is best effort. The local connection is deleted
      // by the caller regardless, so a revoked-or-already-invalid token here is
      // not an error worth failing the disconnect over.
    }
  }
}

function toTokenSet(data: XTokenResponse): TokenSet {
  return {
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    ...(data.expires_in ? { expiresAt: new Date(Date.now() + data.expires_in * 1000) } : {}),
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : [],
  };
}

function createS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
