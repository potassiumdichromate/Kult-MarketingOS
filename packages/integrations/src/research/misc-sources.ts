import { providerRequest } from '../social/http.js';
import { safeFetch } from '../safe-fetch.js';
import { stripHtml } from './rss.js';
import {
  configStringArray,
  type CollectedItem,
  type CollectOptions,
  type ResearchSourceAdapter,
  type SourceAvailability,
} from './types.js';

/**
 * Fetches specific pages an organization nominates - a competitor's blog index,
 * a changelog, a docs page. URLs come from user configuration, so every fetch
 * goes through the SSRF-guarded client.
 */
export class CustomUrlSourceAdapter implements ResearchSourceAdapter {
  readonly type = 'CUSTOM_URL' as const;

  availability(): SourceAvailability {
    return { available: true };
  }

  async collect(options: CollectOptions): Promise<CollectedItem[]> {
    const urls = configStringArray(options.config, 'urls');
    const results: CollectedItem[] = [];

    for (const url of urls.slice(0, options.limit)) {
      const response = await safeFetch(url, {
        headers: { accept: 'text/html,application/xhtml+xml' },
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: 20_000,
      });

      const title = extractTitle(response.body) ?? url;
      const body = stripHtml(response.body);

      results.push({
        url: response.url,
        title,
        ...(body ? { body } : {}),
        engagement: {},
        raw: { status: response.status, contentType: response.contentType, truncated: response.truncated },
      });
    }

    return results;
  }
}

function extractTitle(html: string): string | undefined {
  const ogTitle = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (ogTitle?.[1]) return stripHtml(ogTitle[1]).slice(0, 300);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1]) return stripHtml(title[1]).slice(0, 300);
  return undefined;
}

/**
 * X as a *research* source, using GET /2/tweets/search/recent with an app-only
 * bearer token.
 *
 * This is separate from the X publishing integration: recent search is gated
 * behind X API access tiers, and the credential is an app-only bearer rather
 * than the member's OAuth token.
 */
export class XSearchSourceAdapter implements ResearchSourceAdapter {
  readonly type = 'X' as const;

  constructor(private readonly bearerToken: string | undefined) {}

  availability(): SourceAvailability {
    if (this.bearerToken) return { available: true };
    return {
      available: false,
      reason:
        'X research requires an app-only Bearer token from an X developer project. Recent search ' +
        'is available on paid X API access tiers; confirm your project tier includes ' +
        'GET /2/tweets/search/recent before enabling this source.',
      requiredVariables: ['X_BEARER_TOKEN'],
    };
  }

  async collect(options: CollectOptions): Promise<CollectedItem[]> {
    const bearer = this.bearerToken;
    if (!bearer) throw new Error(this.availability().reason ?? 'X research is not configured.');

    const queries = configStringArray(options.config, 'queries');
    const results: CollectedItem[] = [];
    const perRequest = Math.min(100, Math.max(10, options.limit));

    for (const query of queries) {
      if (results.length >= options.limit) break;

      const params = new URLSearchParams({
        query,
        max_results: String(perRequest),
        'tweet.fields': 'created_at,public_metrics,author_id,lang',
        expansions: 'author_id',
        'user.fields': 'username,name',
      });
      if (options.since) params.set('start_time', options.since.toISOString());

      const { data } = await providerRequest<{
        data?: Array<{
          id: string;
          text: string;
          created_at?: string;
          author_id?: string;
          lang?: string;
          public_metrics?: Record<string, number>;
        }>;
        includes?: { users?: Array<{ id: string; username?: string; name?: string }> };
      }>({
        provider: 'X',
        url: `https://api.x.com/2/tweets/search/recent?${params.toString()}`,
        headers: { authorization: `Bearer ${bearer}` },
      });

      const usersById = new Map(
        (data.includes?.users ?? []).map((user) => [user.id, user.username ?? user.name ?? user.id]),
      );

      for (const post of data.data ?? []) {
        const author = post.author_id ? usersById.get(post.author_id) : undefined;
        const engagement: Record<string, number> = {};
        for (const [key, value] of Object.entries(post.public_metrics ?? {})) {
          if (typeof value === 'number') engagement[key] = value;
        }

        results.push({
          url: author
            ? `https://x.com/${author}/status/${post.id}`
            : `https://x.com/i/status/${post.id}`,
          // A post has no separate title; the first line stands in for one.
          title: post.text.split('\n')[0]?.slice(0, 300) ?? post.text.slice(0, 300),
          body: post.text,
          ...(author ? { author } : {}),
          ...(post.created_at ? { publishedAt: new Date(post.created_at) } : {}),
          engagement,
          raw: { id: post.id, lang: post.lang ?? null, query },
        });

        if (results.length >= options.limit) break;
      }
    }

    return results;
  }
}

/**
 * Google Trends.
 *
 * Google publishes no official, generally available Google Trends API. Rather
 * than scrape an undocumented internal endpoint - which would be unreliable and
 * against Google's terms - this source is permanently reported as unavailable
 * with an explanation. It appears in the research UI so the limitation is
 * visible rather than silently missing.
 */
export class GoogleTrendsSourceAdapter implements ResearchSourceAdapter {
  readonly type = 'GOOGLE_TRENDS' as const;

  availability(): SourceAvailability {
    return {
      available: false,
      reason:
        'Google does not offer an official public Google Trends API, so this source cannot be ' +
        'collected. Trend velocity is derived instead from the RSS, Reddit, YouTube, X, and web ' +
        'search sources. If your organization has access to Google Trends data through an ' +
        'approved export, add it as a CUSTOM_URL or RSS source.',
      requiredVariables: [],
    };
  }

  async collect(): Promise<CollectedItem[]> {
    throw new Error(this.availability().reason);
  }
}
