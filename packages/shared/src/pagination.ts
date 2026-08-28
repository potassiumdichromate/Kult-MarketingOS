import { z } from 'zod';

/**
 * Cursor pagination shared by every list endpoint.
 *
 * Cursors are opaque base64url of `{createdAt ISO}|{id}` so pages remain stable
 * while rows are being inserted. Offset pagination is deliberately not offered:
 * research and content tables receive continuous writes.
 */

export const paginationQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface DecodedCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator === -1) return null;
    const createdAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Builds a page from `limit + 1` rows fetched by the caller. Fetching one extra
 * row is how `hasMore` is determined without a second count query.
 */
export function buildPage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}
