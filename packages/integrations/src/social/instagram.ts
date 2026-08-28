import type { MetaConfig } from '@kult/config';
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
 * Instagram provider, implemented against Instagram Login (Business Login for
 * Instagram) and the Instagram Content Publishing API.
 *
 * Verified against the current official Meta documentation (2026-08):
 *   authorize      GET  https://www.instagram.com/oauth/authorize
 *   short token    POST https://api.instagram.com/oauth/access_token
 *   long token     GET  https://graph.instagram.com/access_token
 *                       ?grant_type=ig_exchange_token          (60 day token)
 *   refresh        GET  https://graph.instagram.com/refresh_access_token
 *                       ?grant_type=ig_refresh_token           (token must be >24h old)
 *   create media   POST https://graph.instagram.com/<version>/<IG_ID>/media
 *   publish media  POST https://graph.instagram.com/<version>/<IG_ID>/media_publish
 *
 * Scopes: instagram_business_basic, instagram_business_content_publish.
 *
 * Two limitations are enforced rather than papered over:
 *
 *  1. Publishing requires an Instagram *professional* account. A personal
 *     account cannot be published to through any official API. The adapter
 *     detects the account type and reports UNSUPPORTED_CAPABILITY.
 *
 *  2. Container creation takes a publicly reachable media URL - Meta fetches the
 *     bytes itself. There is no binary upload path. If object storage has no
 *     public base URL configured, publishing is refused with that exact
 *     requirement instead of failing obscurely inside Meta.
 */

const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const SHORT_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const GRAPH_BASE = 'https://graph.instagram.com';

/** Documented ceiling: 100 API-published posts per rolling 24 hours. */
export const INSTAGRAM_DAILY_PUBLISH_LIMIT = 100;

interface ShortTokenResponse {
  access_token: string;
  user_id?: string | number;
  permissions?: string | string[];
}

interface LongTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

interface IgAccountResponse {
  id: string;
  user_id?: string;
  username?: string;
  name?: string;
  account_type?: string;
  profile_picture_url?: string;
  followers_count?: number;
  media_count?: number;
}

interface ContainerResponse {
  id?: string;
}

interface ContainerStatusResponse {
  status_code?: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
  status?: string;
}

interface InsightsResponse {
  data?: Array<{ name?: string; values?: Array<{ value?: number }> }>;
}

export class InstagramProvider implements SocialProviderAdapter {
  readonly name = 'INSTAGRAM' as const;
  readonly configured: boolean;
  readonly requestedScopes = ['instagram_business_basic', 'instagram_business_content_publish'];

  constructor(
    private readonly config: MetaConfig | undefined,
    /**
     * Resolves an object storage key to a publicly reachable URL. Returns null
     * when the deployment has no public base URL, which makes Instagram media
     * publishing impossible - reported, never faked.
     */
    private readonly resolvePublicUrl: (key: string) => string | null = () => null,
  ) {
    this.configured = Boolean(config);
  }

  private requireConfig(): MetaConfig {
    if (!this.config) {
      throw new NotConfiguredError('The Instagram integration', [
        'META_APP_ID',
        'META_APP_SECRET',
        'META_REDIRECT_URI',
      ]);
    }
    return this.config;
  }

  private graph(path: string): string {
    const config = this.requireConfig();
    return `${GRAPH_BASE}/${config.graphVersion}/${path}`;
  }

  getAuthorizationUrl(input: { state: string }): AuthorizationRequest {
    const config = this.requireConfig();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.requestedScopes.join(','));
    url.searchParams.set('state', input.state);
    return { url: url.toString(), state: input.state };
  }

  /**
   * Exchanges the code for a short-lived token, then immediately upgrades it to
   * the 60-day long-lived token. Only the long-lived token is ever stored.
   */
  async handleOAuthCallback(input: { code: string }): Promise<TokenSet> {
    const config = this.requireConfig();

    const shortBody = new URLSearchParams({
      client_id: config.appId,
      client_secret: config.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code: input.code,
    });

    const short = await providerRequest<ShortTokenResponse>({
      provider: 'Instagram',
      url: SHORT_TOKEN_URL,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: shortBody,
    });

    const grantedScopes = normalisePermissions(short.data.permissions) ?? this.requestedScopes;

    const longUrl = new URL(`${GRAPH_BASE}/access_token`);
    longUrl.searchParams.set('grant_type', 'ig_exchange_token');
    longUrl.searchParams.set('client_secret', config.appSecret);
    longUrl.searchParams.set('access_token', short.data.access_token);

    const long = await providerRequest<LongTokenResponse>({
      provider: 'Instagram',
      url: longUrl.toString(),
    });

    return {
      accessToken: long.data.access_token,
      ...(long.data.expires_in
        ? { expiresAt: new Date(Date.now() + long.data.expires_in * 1000) }
        : {}),
      scopes: grantedScopes,
    };
  }

  /**
   * Instagram long-lived tokens are refreshed with the token itself; there is no
   * separate refresh token. `refreshToken` therefore receives the current access
   * token, and the caller stores the result as the new access token.
   */
  async refreshToken(currentAccessToken: string): Promise<TokenSet> {
    const url = new URL(`${GRAPH_BASE}/refresh_access_token`);
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', currentAccessToken);

    const { data } = await providerRequest<LongTokenResponse>({
      provider: 'Instagram',
      url: url.toString(),
    });

    return {
      accessToken: data.access_token,
      ...(data.expires_in ? { expiresAt: new Date(Date.now() + data.expires_in * 1000) } : {}),
      scopes: [],
    };
  }

  async getAccount(tokens: TokenSet): Promise<ProviderAccount> {
    const url = new URL(`${GRAPH_BASE}/me`);
    url.searchParams.set(
      'fields',
      'id,user_id,username,name,account_type,profile_picture_url,followers_count,media_count',
    );
    url.searchParams.set('access_token', tokens.accessToken);

    const { data } = await providerRequest<IgAccountResponse>({
      provider: 'Instagram',
      url: url.toString(),
    });

    if (!data.id) {
      throw new ProviderError('Instagram', 'Instagram did not return an account for this token.', {
        retryable: false,
      });
    }

    return {
      providerAccountId: data.id,
      accountName: data.name ?? data.username ?? data.id,
      ...(data.username ? { accountUsername: data.username } : {}),
      metadata: {
        accountType: data.account_type ?? null,
        profilePictureUrl: data.profile_picture_url ?? null,
        followersCount: data.followers_count ?? null,
        mediaCount: data.media_count ?? null,
        dailyPublishLimit: INSTAGRAM_DAILY_PUBLISH_LIMIT,
      },
    };
  }

  async resolveCapabilities(input: {
    tokens: TokenSet;
    account: ProviderAccount;
  }): Promise<ConnectionCapabilities> {
    const granted = new Set(input.tokens.scopes);
    const missing = this.requestedScopes.filter((scope) => !granted.has(scope));
    const unavailable: Record<string, string> = {};

    const accountType = String(input.account.metadata.accountType ?? '').toUpperCase();
    // Meta reports professional accounts as BUSINESS or MEDIA_CREATOR.
    const isProfessional =
      accountType === 'BUSINESS' || accountType === 'MEDIA_CREATOR' || accountType === 'CREATOR';

    // An empty scope list means the token response did not enumerate permissions;
    // that is not evidence the scope is absent, so publishing is not pre-blocked
    // on it. A genuine missing permission surfaces at publish time as a provider
    // error, which is recorded rather than swallowed.
    const scopesKnown = input.tokens.scopes.length > 0;
    const hasPublishScope = !scopesKnown || granted.has('instagram_business_content_publish');

    let publishable: ContentType[] = [];
    if (!isProfessional) {
      unavailable.publish =
        `The connected account type is "${accountType || 'unknown'}". Instagram's Content ` +
        'Publishing API only publishes to professional accounts. Convert the account to a ' +
        'Business or Creator account in the Instagram app, then reconnect it here.';
    } else if (!hasPublishScope) {
      unavailable.publish =
        'The "instagram_business_content_publish" permission was not granted. Reconnect the ' +
        'account and approve content publishing.';
    } else if (!this.hasPublicMediaHosting()) {
      unavailable.publish =
        'Instagram builds a media container by fetching a publicly reachable URL; it accepts no ' +
        'direct binary upload. Set STORAGE_PUBLIC_BASE_URL to a publicly readable bucket or CDN ' +
        'origin so uploaded media can be handed to Instagram.';
    } else {
      publishable = ['INSTAGRAM_CAPTION', 'INSTAGRAM_REEL', 'INSTAGRAM_CAROUSEL'];
    }

    unavailable.stories =
      'Story publishing is not implemented by this integration. Only feed images, reels, and ' +
      'carousels are published.';

    return {
      publishableContentTypes: publishable,
      unavailable,
      grantedScopes: [...granted],
      missingScopes: missing,
      canReadMetrics: isProfessional,
    };
  }

  private hasPublicMediaHosting(): boolean {
    return this.resolvePublicUrl('probe') !== null;
  }

  async validateConnection(tokens: TokenSet): Promise<ValidationResult> {
    try {
      const account = await this.getAccount(tokens);
      const capabilities = await this.resolveCapabilities({ tokens, account });
      return { valid: true, account, capabilities };
    } catch (error) {
      const status = error instanceof ProviderError ? error.providerStatus : undefined;
      return {
        valid: false,
        reason:
          error instanceof Error ? error.message : 'The Instagram connection could not be validated.',
        requiresReauthorization: status === 400 || status === 401 || status === 403,
      };
    }
  }

  /**
   * Creates a media container. This is Instagram's only upload mechanism: the
   * media must already be hosted at a public URL that Meta can fetch.
   */
  async createMediaUpload(input: {
    tokens: TokenSet;
    account: ProviderAccount;
    publicUrl?: string;
    mimeType: string;
    altText?: string;
  }): Promise<MediaUploadResult> {
    if (!input.publicUrl) {
      throw new UnsupportedCapabilityError(
        'Instagram',
        'binary media upload',
        'Instagram creates a media container from a publicly reachable URL and does not accept a ' +
          'direct binary upload. Configure STORAGE_PUBLIC_BASE_URL so media assets have a public URL.',
      );
    }

    const isVideo = input.mimeType.startsWith('video/');
    const body = new URLSearchParams({
      access_token: input.tokens.accessToken,
      ...(isVideo
        ? { media_type: 'REELS', video_url: input.publicUrl }
        : { image_url: input.publicUrl }),
      ...(input.altText ? { alt_text: input.altText } : {}),
    });

    const { data } = await providerRequest<ContainerResponse>({
      provider: 'Instagram',
      url: this.graph(`${input.account.providerAccountId}/media`),
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!data.id) {
      throw new ProviderError('Instagram', 'Instagram did not return a media container id.', {
        retryable: true,
      });
    }
    return { mediaId: data.id, metadata: { mediaType: isVideo ? 'REELS' : 'IMAGE' } };
  }

  async createPost(input: {
    tokens: TokenSet;
    account: ProviderAccount;
    post: PublishInput;
  }): Promise<PublishResult> {
    const { tokens, account, post } = input;

    const capabilities = await this.resolveCapabilities({ tokens, account });
    if (!capabilities.publishableContentTypes.includes(post.contentType)) {
      throw new UnsupportedCapabilityError(
        'Instagram',
        post.contentType,
        capabilities.unavailable.publish ??
          `${post.contentType} cannot be published to this Instagram connection.`,
      );
    }

    const media = post.media ?? [];
    if (media.length === 0) {
      throw new ProviderError('Instagram', 'Instagram posts require at least one media asset.', {
        retryable: false,
      });
    }

    const caption = buildCaption(post);
    let containerId: string;

    if (post.contentType === 'INSTAGRAM_CAROUSEL') {
      if (media.length < 2) {
        throw new ProviderError('Instagram', 'A carousel requires at least two media items.', {
          retryable: false,
        });
      }
      if (media.length > 10) {
        throw new ProviderError(
          'Instagram',
          'Instagram carousels are limited to 10 items.',
          { retryable: false },
        );
      }

      const childIds: string[] = [];
      for (const item of media) {
        const child = await this.createCarouselChild({
          tokens,
          account,
          publicUrl: item.publicUrl,
          mimeType: item.mimeType,
        });
        childIds.push(child);
      }

      const { data } = await providerRequest<ContainerResponse>({
        provider: 'Instagram',
        url: this.graph(`${account.providerAccountId}/media`),
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          access_token: tokens.accessToken,
          media_type: 'CAROUSEL',
          children: childIds.join(','),
          caption,
        }),
      });
      if (!data.id) {
        throw new ProviderError('Instagram', 'Instagram did not return a carousel container id.', {
          retryable: true,
        });
      }
      containerId = data.id;
    } else {
      const first = media[0];
      if (!first) {
        throw new ProviderError('Instagram', 'No media supplied.', { retryable: false });
      }
      const isReel = post.contentType === 'INSTAGRAM_REEL';
      const body = new URLSearchParams({
        access_token: tokens.accessToken,
        caption,
        ...(isReel || first.mimeType.startsWith('video/')
          ? { media_type: 'REELS', video_url: requirePublicUrl(first.publicUrl) }
          : { image_url: requirePublicUrl(first.publicUrl) }),
      });

      const { data } = await providerRequest<ContainerResponse>({
        provider: 'Instagram',
        url: this.graph(`${account.providerAccountId}/media`),
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!data.id) {
        throw new ProviderError('Instagram', 'Instagram did not return a media container id.', {
          retryable: true,
        });
      }
      containerId = data.id;
    }

    // Video and carousel containers are processed asynchronously; publishing
    // before FINISHED returns an error, so wait for a terminal state first.
    await this.awaitContainerReady(tokens, containerId);

    const publish = await providerRequest<ContainerResponse>({
      provider: 'Instagram',
      url: this.graph(`${account.providerAccountId}/media_publish`),
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        access_token: tokens.accessToken,
        creation_id: containerId,
      }),
    });

    const mediaId = publish.data.id;
    if (!mediaId) {
      throw new ProviderError('Instagram', 'Instagram did not return a published media id.', {
        retryable: true,
      });
    }

    return {
      providerPostId: mediaId,
      providerPostIds: [mediaId],
      publishedAt: new Date(),
      metadata: { containerId },
    };
  }

  private async createCarouselChild(input: {
    tokens: TokenSet;
    account: ProviderAccount;
    publicUrl?: string;
    mimeType: string;
  }): Promise<string> {
    const isVideo = input.mimeType.startsWith('video/');
    const { data } = await providerRequest<ContainerResponse>({
      provider: 'Instagram',
      url: this.graph(`${input.account.providerAccountId}/media`),
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        access_token: input.tokens.accessToken,
        is_carousel_item: 'true',
        ...(isVideo
          ? { media_type: 'VIDEO', video_url: requirePublicUrl(input.publicUrl) }
          : { image_url: requirePublicUrl(input.publicUrl) }),
      }),
    });
    if (!data.id) {
      throw new ProviderError('Instagram', 'Instagram did not return a carousel child id.', {
        retryable: true,
      });
    }
    return data.id;
  }

  private async awaitContainerReady(tokens: TokenSet, containerId: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const url = new URL(`${GRAPH_BASE}/${containerId}`);
      url.searchParams.set('fields', 'status_code,status');
      url.searchParams.set('access_token', tokens.accessToken);

      const { data } = await providerRequest<ContainerStatusResponse>({
        provider: 'Instagram',
        url: url.toString(),
      });

      const status = data.status_code;
      if (status === 'FINISHED' || status === 'PUBLISHED') return;
      if (status === 'ERROR') {
        throw new ProviderError('Instagram', `Instagram failed to process the media container. ${data.status ?? ''}`.trim(), {
          retryable: false,
        });
      }
      if (status === 'EXPIRED') {
        throw new ProviderError('Instagram', 'The Instagram media container expired before publishing.', {
          retryable: true,
        });
      }
      await sleep(3_000);
    }
    throw new ProviderError('Instagram', 'The Instagram media container did not finish processing in time.', {
      retryable: true,
    });
  }

  async getPost(input: {
    tokens: TokenSet;
    providerPostId: string;
  }): Promise<Record<string, unknown>> {
    const url = new URL(`${GRAPH_BASE}/${input.providerPostId}`);
    url.searchParams.set('fields', 'id,caption,media_type,media_url,permalink,timestamp');
    url.searchParams.set('access_token', input.tokens.accessToken);
    const { data } = await providerRequest<Record<string, unknown>>({
      provider: 'Instagram',
      url: url.toString(),
    });
    return data;
  }

  /**
   * Reads media insights. Metric availability varies by media type and account,
   * so any metric Instagram omits stays undefined rather than being zero-filled.
   */
  async getMetrics(input: {
    tokens: TokenSet;
    providerPostId: string;
  }): Promise<PostMetrics> {
    const url = new URL(`${GRAPH_BASE}/${input.providerPostId}/insights`);
    url.searchParams.set('metric', 'reach,likes,comments,shares,saved,views');
    url.searchParams.set('access_token', input.tokens.accessToken);

    const { data } = await providerRequest<InsightsResponse>({
      provider: 'Instagram',
      url: url.toString(),
    });

    const values = new Map<string, number>();
    for (const entry of data.data ?? []) {
      const value = entry.values?.[0]?.value;
      if (entry.name && typeof value === 'number') values.set(entry.name, value);
    }

    const pick = (name: string): number | undefined => values.get(name);

    return {
      providerPostId: input.providerPostId,
      capturedAt: new Date(),
      ...(pick('reach') !== undefined ? { impressions: pick('reach') } : {}),
      ...(pick('likes') !== undefined ? { likes: pick('likes') } : {}),
      ...(pick('comments') !== undefined ? { comments: pick('comments') } : {}),
      ...(pick('shares') !== undefined ? { shares: pick('shares') } : {}),
      ...(pick('saved') !== undefined ? { saves: pick('saved') } : {}),
      ...(pick('views') !== undefined ? { videoViews: pick('views') } : {}),
      raw: Object.fromEntries(values),
    };
  }

  /**
   * Instagram Login exposes no token revocation endpoint. The connection is
   * removed locally; a member revokes app access from Instagram's own settings.
   */
  async disconnect(): Promise<void> {
    return;
  }
}

function requirePublicUrl(publicUrl: string | undefined): string {
  if (!publicUrl) {
    throw new UnsupportedCapabilityError(
      'Instagram',
      'binary media upload',
      'Instagram fetches media from a public URL. This asset has no public URL - configure ' +
        'STORAGE_PUBLIC_BASE_URL so uploaded media is publicly readable.',
    );
  }
  return publicUrl;
}

function buildCaption(post: PublishInput): string {
  const hashtags = (post.hashtags ?? []).map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
  return hashtags.length > 0 ? `${post.body}\n\n${hashtags.join(' ')}` : post.body;
}

function normalisePermissions(permissions: string | string[] | undefined): string[] | undefined {
  if (!permissions) return undefined;
  if (Array.isArray(permissions)) return permissions;
  return permissions.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
