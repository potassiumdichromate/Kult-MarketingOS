import type { AppConfig } from '@kult/config';
import type { ResearchSourceType } from '@kult/shared';
import { RssSourceAdapter } from './rss.js';
import { RedditSourceAdapter } from './reddit.js';
import { YouTubeSourceAdapter } from './youtube.js';
import {
  CustomUrlSourceAdapter,
  GoogleTrendsSourceAdapter,
  XSearchSourceAdapter,
} from './misc-sources.js';
import type { ResearchSourceAdapter, SourceAvailability } from './types.js';

/**
 * Registry of research source adapters.
 *
 * The WEB adapter is injected rather than constructed here: it is backed by the
 * model provider's hosted web search tool, which lives in @kult/ai. Keeping the
 * dependency pointing that way avoids a cycle between the two packages.
 */
export class ResearchSourceRegistry {
  private readonly adapters = new Map<ResearchSourceType, ResearchSourceAdapter>();

  constructor(config: AppConfig, webAdapter?: ResearchSourceAdapter) {
    this.adapters.set('RSS', new RssSourceAdapter('RSS'));
    this.adapters.set('NEWS', new RssSourceAdapter('NEWS'));
    this.adapters.set('REDDIT', new RedditSourceAdapter(config.research.reddit));
    this.adapters.set('YOUTUBE', new YouTubeSourceAdapter(config.research.youtubeApiKey));
    this.adapters.set('X', new XSearchSourceAdapter(config.research.xBearerToken));
    this.adapters.set('CUSTOM_URL', new CustomUrlSourceAdapter());
    this.adapters.set('GOOGLE_TRENDS', new GoogleTrendsSourceAdapter());
    if (webAdapter) this.adapters.set('WEB', webAdapter);
  }

  get(type: ResearchSourceType): ResearchSourceAdapter | undefined {
    return this.adapters.get(type);
  }

  /**
   * Availability of every source type, for the research settings screen.
   * A type with no registered adapter is reported as unavailable rather than
   * omitted, so operators can see the whole surface.
   */
  availability(): Record<ResearchSourceType, SourceAvailability> {
    const types: ResearchSourceType[] = [
      'WEB',
      'RSS',
      'REDDIT',
      'X',
      'YOUTUBE',
      'GOOGLE_TRENDS',
      'NEWS',
      'CUSTOM_URL',
    ];

    const result = {} as Record<ResearchSourceType, SourceAvailability>;
    for (const type of types) {
      const adapter = this.adapters.get(type);
      result[type] = adapter
        ? adapter.availability()
        : {
            available: false,
            reason: `No adapter is registered for the ${type} source type in this deployment.`,
          };
    }
    return result;
  }
}

export type { ResearchSourceAdapter, SourceAvailability } from './types.js';
