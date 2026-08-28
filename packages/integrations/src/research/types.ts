import type { ResearchSourceType } from '@kult/shared';

/**
 * Research source adapters.
 *
 * Each adapter turns one external source into normalised ResearchItems. Two
 * rules hold across all of them:
 *
 *  1. An adapter that cannot run says so through `availability()` with a reason
 *     an operator can act on. It never returns synthetic items.
 *  2. Engagement metrics are copied only when the source actually returned them.
 *     A missing metric stays missing rather than becoming zero.
 */

export interface CollectedItem {
  url?: string;
  title: string;
  body?: string;
  author?: string;
  publishedAt?: Date;
  /** Only keys the source genuinely provided. */
  engagement: Record<string, number>;
  /** Verbatim provider payload, retained as evidence. */
  raw: Record<string, unknown>;
}

export interface SourceAvailability {
  available: boolean;
  /** Operator-facing explanation when unavailable. Surfaced in the research UI. */
  reason?: string;
  /** Environment variables that would enable this source. */
  requiredVariables?: string[];
}

export interface CollectOptions {
  /** Adapter-specific configuration from the ResearchSource row. */
  config: Record<string, unknown>;
  /** Only collect items newer than this, where the source supports filtering. */
  since?: Date;
  limit: number;
}

export interface ResearchSourceAdapter {
  readonly type: ResearchSourceType;
  availability(): SourceAvailability;
  collect(options: CollectOptions): Promise<CollectedItem[]>;
}

/** Reads a string field from adapter config, with an optional default. */
export function configString(
  config: Record<string, unknown>,
  key: string,
  fallback?: string,
): string | undefined {
  const value = config[key];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return fallback;
}

/** Reads a string-array field from adapter config. */
export function configStringArray(config: Record<string, unknown>, key: string): string[] {
  const value = config[key];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}
