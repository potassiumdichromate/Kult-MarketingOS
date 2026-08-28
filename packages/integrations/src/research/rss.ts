import { XMLParser } from 'fast-xml-parser';
import { ValidationError } from '@kult/shared';
import { safeFetch } from '../safe-fetch.js';
import {
  configStringArray,
  type CollectedItem,
  type CollectOptions,
  type ResearchSourceAdapter,
  type SourceAvailability,
} from './types.js';

/**
 * RSS / Atom feed adapter.
 *
 * Feed URLs come from the organization's own ResearchSource configuration, so
 * they are untrusted input and are fetched through the SSRF-guarded client.
 * Handles both RSS 2.0 (`rss.channel.item`) and Atom (`feed.entry`).
 *
 * Also backs the NEWS source type, which is RSS under a different label: news
 * publishers expose feeds, and there is no single official "news API" this
 * application is entitled to assume.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
});

interface FeedNode {
  rss?: { channel?: RssChannel | RssChannel[] };
  feed?: AtomFeed;
}

interface RssChannel {
  title?: unknown;
  item?: RssItem | RssItem[];
}

interface RssItem {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  'content:encoded'?: unknown;
  pubDate?: unknown;
  author?: unknown;
  'dc:creator'?: unknown;
  guid?: unknown;
}

interface AtomFeed {
  title?: unknown;
  entry?: AtomEntry | AtomEntry[];
}

interface AtomEntry {
  title?: unknown;
  link?: unknown;
  summary?: unknown;
  content?: unknown;
  updated?: unknown;
  published?: unknown;
  author?: { name?: unknown } | Array<{ name?: unknown }>;
  id?: unknown;
}

export class RssSourceAdapter implements ResearchSourceAdapter {
  constructor(readonly type: 'RSS' | 'NEWS' = 'RSS') {}

  availability(): SourceAvailability {
    // Needs no credentials: feeds are public HTTP.
    return { available: true };
  }

  async collect(options: CollectOptions): Promise<CollectedItem[]> {
    const feedUrls = configStringArray(options.config, 'feedUrls');
    if (feedUrls.length === 0) {
      throw new ValidationError('This RSS source has no feed URLs configured.', [
        { path: 'config.feedUrls', message: 'At least one feed URL is required.' },
      ]);
    }

    const items: CollectedItem[] = [];
    for (const feedUrl of feedUrls) {
      if (items.length >= options.limit) break;
      const collected = await this.collectOne(feedUrl, options);
      items.push(...collected);
    }
    return items.slice(0, options.limit);
  }

  private async collectOne(feedUrl: string, options: CollectOptions): Promise<CollectedItem[]> {
    const response = await safeFetch(feedUrl, {
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 20_000,
    });

    let parsed: FeedNode;
    try {
      parsed = parser.parse(response.body) as FeedNode;
    } catch {
      throw new ValidationError(`The feed at ${feedUrl} is not valid XML.`, [
        { path: 'config.feedUrls', message: 'Feed could not be parsed.' },
      ]);
    }

    const rssChannel = Array.isArray(parsed.rss?.channel)
      ? parsed.rss?.channel[0]
      : parsed.rss?.channel;

    if (rssChannel) return this.fromRss(rssChannel, feedUrl, options);
    if (parsed.feed) return this.fromAtom(parsed.feed, feedUrl, options);
    return [];
  }

  private fromRss(channel: RssChannel, feedUrl: string, options: CollectOptions): CollectedItem[] {
    const entries = toArray(channel.item);
    const results: CollectedItem[] = [];

    for (const entry of entries) {
      const title = text(entry.title);
      if (!title) continue;

      const publishedAt = parseDate(text(entry.pubDate));
      if (options.since && publishedAt && publishedAt < options.since) continue;

      const link = text(entry.link) ?? text(entry.guid);
      const body = stripHtml(text(entry['content:encoded']) ?? text(entry.description) ?? '');

      results.push({
        ...(link ? { url: link } : {}),
        title,
        ...(body ? { body } : {}),
        ...(text(entry.author) || text(entry['dc:creator'])
          ? { author: text(entry.author) ?? text(entry['dc:creator']) ?? '' }
          : {}),
        ...(publishedAt ? { publishedAt } : {}),
        // RSS carries no engagement data.
        engagement: {},
        raw: { feedUrl, feedTitle: text(channel.title) ?? null, format: 'rss' },
      });

      if (results.length >= options.limit) break;
    }
    return results;
  }

  private fromAtom(feed: AtomFeed, feedUrl: string, options: CollectOptions): CollectedItem[] {
    const entries = toArray(feed.entry);
    const results: CollectedItem[] = [];

    for (const entry of entries) {
      const title = text(entry.title);
      if (!title) continue;

      const publishedAt = parseDate(text(entry.published) ?? text(entry.updated));
      if (options.since && publishedAt && publishedAt < options.since) continue;

      const link = atomLink(entry.link) ?? text(entry.id);
      const body = stripHtml(text(entry.content) ?? text(entry.summary) ?? '');
      const authorNode = Array.isArray(entry.author) ? entry.author[0] : entry.author;
      const author = text(authorNode?.name);

      results.push({
        ...(link ? { url: link } : {}),
        title,
        ...(body ? { body } : {}),
        ...(author ? { author } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        engagement: {},
        raw: { feedUrl, feedTitle: text(feed.title) ?? null, format: 'atom' },
      });

      if (results.length >= options.limit) break;
    }
    return results;
  }
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Feed values arrive as strings, numbers, or `{ '#text': ... }` nodes. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value !== null && '#text' in value) {
    return text((value as Record<string, unknown>)['#text']);
  }
  return undefined;
}

/** Atom links are attribute-bearing; prefer rel="alternate". */
function atomLink(link: unknown): string | undefined {
  const links = toArray(link as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const alternate = links.find((entry) => entry?.['@_rel'] === 'alternate') ?? links[0];
  const href = alternate?.['@_href'];
  return typeof href === 'string' ? href : text(link);
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Removes markup from feed content. Feed bodies are untrusted third-party text
 * that later reaches a language model, so tags are stripped before storage.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20_000);
}
