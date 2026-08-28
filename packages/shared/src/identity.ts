import { createHash, randomUUID } from 'node:crypto';

/**
 * Content identity: hashing, canonicalisation, and idempotency keys.
 *
 * The publishing idempotency key is the backbone of the "never publish twice"
 * guarantee. It is derived purely from the identity of what is being published,
 * so a worker retry - or a duplicate queue job after a restart - recomputes the
 * same key and short-circuits against the existing Publication row.
 */

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Canonicalises a URL so the same article discovered through different feeds
 * deduplicates to one ResearchItem.
 *
 * - lowercases scheme and host, strips `www.`
 * - drops the fragment
 * - removes tracking parameters
 * - sorts remaining query parameters
 * - strips a trailing slash from non-root paths
 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'ref_src',
  'ref_url',
  's',
  'spm',
  'yclid',
  '_hsenc',
  '_hsmi',
]);

export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

/** Stable hash for research deduplication: canonical URL when present, else content. */
export function researchItemHash(input: { url?: string | null; title: string; body?: string | null }): string {
  if (input.url) {
    try {
      return sha256(`url:${canonicalizeUrl(input.url)}`);
    } catch {
      // Fall through to content hashing for malformed URLs.
    }
  }
  const normalised = `${input.title}\n${input.body ?? ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
  return sha256(`content:${normalised}`);
}

/**
 * Publishing idempotency key.
 *
 * Includes contentVersion so that an intentional edit-then-republish produces a
 * genuinely new key, while any retry of the *same* version does not.
 */
export function publishingIdempotencyKey(input: {
  organizationId: string;
  socialConnectionId: string;
  contentItemId: string;
  contentVersion: number;
}): string {
  return sha256(
    [
      input.organizationId,
      input.socialConnectionId,
      input.contentItemId,
      String(input.contentVersion),
    ].join(':'),
  );
}

/** Redis key for the distributed publishing lock guarding a single content item. */
export function publishingLockKey(idempotencyKey: string): string {
  return `kult:publish:lock:${idempotencyKey}`;
}

/**
 * Deterministic BullMQ job id for a scheduled publication. Reconciliation relies
 * on this: given a ContentItem we can always ask Redis whether its job exists.
 */
export function publishJobId(contentItemId: string, contentVersion: number): string {
  return `publish:${contentItemId}:${contentVersion}`;
}

/** Redacts anything that looks like a secret before a value reaches the logs. */
const SECRET_KEY_PATTERN =
  /(token|secret|password|authorization|api[-_]?key|client[-_]?secret|refresh|cookie|encryption)/i;

export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactSecrets(entry, depth + 1);
    }
    return output as unknown as T;
  }
  return value;
}
