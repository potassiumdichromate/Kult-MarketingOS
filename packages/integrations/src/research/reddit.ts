import type { RedditConfig } from '@kult/config';
import { basicAuthHeader, providerRequest } from '../social/http.js';
import {
  configStringArray,
  type CollectedItem,
  type CollectOptions,
  type ResearchSourceAdapter,
  type SourceAvailability,
} from './types.js';

/**
 * Reddit research adapter.
 *
 * Uses Reddit's application-only OAuth (`grant_type=client_credentials`) against
 * https://www.reddit.com/api/v1/access_token, then reads listings from
 * https://oauth.reddit.com. Reddit requires a descriptive, unique User-Agent on
 * every request, which is why REDDIT_USER_AGENT is mandatory rather than optional.
 *
 * Read-only: this adapter never posts to Reddit.
 */

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';

interface RedditTokenResponse {
  access_token: string;
  expires_in?: number;
}

interface RedditListing {
  data?: {
    children?: Array<{
      data?: {
        id?: string;
        title?: string;
        selftext?: string;
        author?: string;
        created_utc?: number;
        permalink?: string;
        url?: string;
        score?: number;
        ups?: number;
        num_comments?: number;
        upvote_ratio?: number;
        subreddit?: string;
        over_18?: boolean;
        stickied?: boolean;
      };
    }>;
  };
}

export class RedditSourceAdapter implements ResearchSourceAdapter {
  readonly type = 'REDDIT' as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: RedditConfig | undefined) {}

  availability(): SourceAvailability {
    if (this.config) return { available: true };
    return {
      available: false,
      reason:
        'Reddit research requires application-only OAuth credentials. Create a "script" app at ' +
        'https://www.reddit.com/prefs/apps and set the three variables below.',
      requiredVariables: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'],
    };
  }

  private async accessToken(): Promise<string> {
    const config = this.config;
    if (!config) throw new Error('Reddit is not configured.');

    // Re-use the token until a minute before it expires.
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const { data } = await providerRequest<RedditTokenResponse>({
      provider: 'Reddit',
      url: TOKEN_URL,
      method: 'POST',
      headers: {
        authorization: basicAuthHeader(config.clientId, config.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': config.userAgent,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });

    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  async collect(options: CollectOptions): Promise<CollectedItem[]> {
    const config = this.config;
    if (!config) {
      const availability = this.availability();
      throw new Error(availability.reason ?? 'Reddit is not configured.');
    }

    const subreddits = configStringArray(options.config, 'subreddits');
    const queries = configStringArray(options.config, 'queries');
    const sort = typeof options.config.sort === 'string' ? options.config.sort : 'hot';
    const timeframe = typeof options.config.timeframe === 'string' ? options.config.timeframe : 'week';

    const token = await this.accessToken();
    const headers = {
      authorization: `Bearer ${token}`,
      'user-agent': config.userAgent,
    };

    const items: CollectedItem[] = [];
    const perRequest = Math.min(100, Math.max(10, options.limit));

    for (const subreddit of subreddits) {
      if (items.length >= options.limit) break;
      const url = `${API_BASE}/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(sort)}?limit=${perRequest}&t=${encodeURIComponent(timeframe)}`;
      const { data } = await providerRequest<RedditListing>({ provider: 'Reddit', url, headers });
      items.push(...this.mapListing(data, options));
    }

    for (const query of queries) {
      if (items.length >= options.limit) break;
      const url =
        `${API_BASE}/search?q=${encodeURIComponent(query)}&limit=${perRequest}` +
        `&sort=${encodeURIComponent(sort === 'hot' ? 'relevance' : sort)}&t=${encodeURIComponent(timeframe)}`;
      const { data } = await providerRequest<RedditListing>({ provider: 'Reddit', url, headers });
      items.push(...this.mapListing(data, options));
    }

    return items.slice(0, options.limit);
  }

  private mapListing(listing: RedditListing, options: CollectOptions): CollectedItem[] {
    const results: CollectedItem[] = [];

    for (const child of listing.data?.children ?? []) {
      const post = child.data;
      if (!post?.title) continue;
      // Pinned moderator posts are noise, not signal.
      if (post.stickied) continue;

      const publishedAt = post.created_utc ? new Date(post.created_utc * 1000) : undefined;
      if (options.since && publishedAt && publishedAt < options.since) continue;

      const engagement: Record<string, number> = {};
      if (typeof post.score === 'number') engagement.score = post.score;
      if (typeof post.ups === 'number') engagement.upvotes = post.ups;
      if (typeof post.num_comments === 'number') engagement.comments = post.num_comments;
      if (typeof post.upvote_ratio === 'number') engagement.upvoteRatio = post.upvote_ratio;

      results.push({
        ...(post.permalink ? { url: `https://www.reddit.com${post.permalink}` } : {}),
        title: post.title,
        ...(post.selftext ? { body: post.selftext.slice(0, 20_000) } : {}),
        ...(post.author ? { author: post.author } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        engagement,
        raw: {
          id: post.id ?? null,
          subreddit: post.subreddit ?? null,
          externalUrl: post.url ?? null,
          nsfw: post.over_18 ?? null,
        },
      });
    }

    return results;
  }
}
