import { providerRequest } from '../social/http.js';
import {
  configStringArray,
  type CollectedItem,
  type CollectOptions,
  type ResearchSourceAdapter,
  type SourceAvailability,
} from './types.js';

/**
 * YouTube research adapter, using the official YouTube Data API v3.
 *
 * search.list finds candidate videos; videos.list then supplies statistics,
 * because search.list does not return view or like counts. Statistics can be
 * hidden by a channel owner, in which case the corresponding metric is simply
 * absent rather than reported as zero.
 */

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

interface SearchResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      description?: string;
      channelTitle?: string;
      publishedAt?: string;
      channelId?: string;
    };
  }>;
}

interface VideosResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      description?: string;
      channelTitle?: string;
      publishedAt?: string;
      tags?: string[];
    };
    statistics?: {
      viewCount?: string;
      likeCount?: string;
      commentCount?: string;
    };
  }>;
}

export class YouTubeSourceAdapter implements ResearchSourceAdapter {
  readonly type = 'YOUTUBE' as const;

  constructor(private readonly apiKey: string | undefined) {}

  availability(): SourceAvailability {
    if (this.apiKey) return { available: true };
    return {
      available: false,
      reason:
        'YouTube research requires a YouTube Data API v3 key from a Google Cloud project with ' +
        'the YouTube Data API enabled.',
      requiredVariables: ['YOUTUBE_API_KEY'],
    };
  }

  async collect(options: CollectOptions): Promise<CollectedItem[]> {
    const apiKey = this.apiKey;
    if (!apiKey) throw new Error(this.availability().reason ?? 'YouTube is not configured.');

    const queries = configStringArray(options.config, 'queries');
    const channelIds = configStringArray(options.config, 'channelIds');
    const perRequest = Math.min(50, Math.max(5, options.limit));

    const videoIds: string[] = [];

    const runSearch = async (params: URLSearchParams): Promise<void> => {
      params.set('key', apiKey);
      params.set('part', 'snippet');
      params.set('type', 'video');
      params.set('maxResults', String(perRequest));
      params.set('order', 'relevance');
      if (options.since) params.set('publishedAfter', options.since.toISOString());

      const { data } = await providerRequest<SearchResponse>({
        provider: 'YouTube',
        url: `${SEARCH_URL}?${params.toString()}`,
      });
      for (const item of data.items ?? []) {
        const id = item.id?.videoId;
        if (id && !videoIds.includes(id)) videoIds.push(id);
      }
    };

    for (const query of queries) {
      if (videoIds.length >= options.limit) break;
      await runSearch(new URLSearchParams({ q: query }));
    }
    for (const channelId of channelIds) {
      if (videoIds.length >= options.limit) break;
      await runSearch(new URLSearchParams({ channelId }));
    }

    if (videoIds.length === 0) return [];

    return this.hydrate(videoIds.slice(0, options.limit), apiKey);
  }

  /** videos.list accepts up to 50 ids per call. */
  private async hydrate(videoIds: string[], apiKey: string): Promise<CollectedItem[]> {
    const results: CollectedItem[] = [];

    for (let offset = 0; offset < videoIds.length; offset += 50) {
      const batch = videoIds.slice(offset, offset + 50);
      const params = new URLSearchParams({
        key: apiKey,
        part: 'snippet,statistics',
        id: batch.join(','),
      });

      const { data } = await providerRequest<VideosResponse>({
        provider: 'YouTube',
        url: `${VIDEOS_URL}?${params.toString()}`,
      });

      for (const video of data.items ?? []) {
        if (!video.id || !video.snippet?.title) continue;

        const engagement: Record<string, number> = {};
        const views = numeric(video.statistics?.viewCount);
        const likes = numeric(video.statistics?.likeCount);
        const comments = numeric(video.statistics?.commentCount);
        // Channels can hide these; absent stays absent.
        if (views !== undefined) engagement.views = views;
        if (likes !== undefined) engagement.likes = likes;
        if (comments !== undefined) engagement.comments = comments;

        const publishedAt = video.snippet.publishedAt
          ? new Date(video.snippet.publishedAt)
          : undefined;

        results.push({
          url: `https://www.youtube.com/watch?v=${video.id}`,
          title: video.snippet.title,
          ...(video.snippet.description
            ? { body: video.snippet.description.slice(0, 20_000) }
            : {}),
          ...(video.snippet.channelTitle ? { author: video.snippet.channelTitle } : {}),
          ...(publishedAt && !Number.isNaN(publishedAt.getTime()) ? { publishedAt } : {}),
          engagement,
          raw: { videoId: video.id, tags: video.snippet.tags ?? [] },
        });
      }
    }

    return results;
  }
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
