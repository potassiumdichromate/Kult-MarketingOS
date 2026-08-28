import { Prisma, type PrismaClient } from '@kult/database';
import { sha256 } from '@kult/shared';
import type { AIService } from './service.js';

/**
 * Brand knowledge base: chunking, embedding, and retrieval.
 *
 * Retrieval ranks inside PostgreSQL using the `kult_cosine_similarity` function
 * installed by migration, so a similarity search never pulls an organization's
 * whole corpus into the application process. That keeps a single indexed,
 * tenant-scoped query on the hot path.
 *
 * Scaling note: this is a sequential scan over one organization's chunks, which
 * is appropriate at brand-knowledge scale (hundreds to low tens of thousands of
 * chunks). If a tenant's corpus outgrows that, the migration path is pgvector
 * with an HNSW index - the retrieval interface below does not change.
 */

export type KnowledgeEntityType =
  | 'BRAND_PROFILE'
  | 'PRODUCT'
  | 'FEATURE'
  | 'AUDIENCE'
  | 'COMPETITOR'
  | 'APPROVED_CLAIM'
  | 'BRAND_GUIDELINE'
  | 'SOURCE_DOCUMENT';

export interface KnowledgeChunkInput {
  entityType: KnowledgeEntityType;
  entityId?: string;
  sourceDocumentId?: string;
  content: string;
  chunkIndex?: number;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  entityType: KnowledgeEntityType;
  entityId: string | null;
  sourceDocumentId: string | null;
  similarity: number;
}

/**
 * Splits text on paragraph boundaries, packing paragraphs up to `maxChars` and
 * carrying `overlapChars` of the previous chunk forward so a fact spanning a
 * boundary stays retrievable. Oversized paragraphs are split on sentences.
 */
export function chunkText(
  text: string,
  { maxChars = 1_500, overlapChars = 200 }: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const normalised = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (normalised.length === 0) return [];
  if (normalised.length <= maxChars) return [normalised];

  const blocks: string[] = [];
  for (const paragraph of normalised.split(/\n\n+/)) {
    if (paragraph.length <= maxChars) {
      blocks.push(paragraph);
      continue;
    }
    // A single oversized paragraph is split on sentence boundaries.
    let buffer = '';
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      if (buffer.length + sentence.length + 1 > maxChars && buffer.length > 0) {
        blocks.push(buffer.trim());
        buffer = '';
      }
      buffer += (buffer ? ' ' : '') + sentence;
    }
    if (buffer.trim()) blocks.push(buffer.trim());
  }

  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (current.length + block.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = overlapChars > 0 ? `${current.slice(-overlapChars)}\n\n` : '';
    }
    current += (current ? '\n\n' : '') + block;
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

export class KnowledgeBase {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ai: AIService,
  ) {}

  /**
   * Embeds and stores chunks.
   *
   * Deduplicates on (organizationId, contentHash): re-indexing an unchanged
   * document is a no-op rather than a duplicate row, so retrieval is not skewed
   * by repeated ingestion.
   */
  async index(organizationId: string, chunks: KnowledgeChunkInput[]): Promise<number> {
    if (chunks.length === 0) return 0;

    const withHashes = chunks.map((chunk) => ({
      ...chunk,
      contentHash: sha256(`${chunk.entityType}:${chunk.entityId ?? ''}:${chunk.content}`),
    }));

    const existing = await this.prisma.knowledgeChunk.findMany({
      where: {
        organizationId,
        contentHash: { in: withHashes.map((chunk) => chunk.contentHash) },
      },
      select: { contentHash: true },
    });
    const known = new Set(existing.map((row) => row.contentHash));
    const pending = withHashes.filter((chunk) => !known.has(chunk.contentHash));
    if (pending.length === 0) return 0;

    // Embed in batches so a large document does not exceed provider input limits.
    const BATCH = 64;
    let written = 0;

    for (let offset = 0; offset < pending.length; offset += BATCH) {
      const batch = pending.slice(offset, offset + BATCH);
      const { vectors } = await this.ai.embed(batch.map((chunk) => chunk.content));

      const rows = batch.map((chunk, index) => ({
        organizationId,
        entityType: chunk.entityType,
        entityId: chunk.entityId ?? null,
        sourceDocumentId: chunk.sourceDocumentId ?? null,
        chunkIndex: chunk.chunkIndex ?? index,
        content: chunk.content,
        contentHash: chunk.contentHash,
        embedding: vectors[index] ?? [],
        tokenCount: estimateTokens(chunk.content),
      }));

      const result = await this.prisma.knowledgeChunk.createMany({
        data: rows,
        skipDuplicates: true,
      });
      written += result.count;
    }

    return written;
  }

  /**
   * Retrieves the chunks most similar to `query`.
   *
   * The organization predicate is inside the SQL, not applied afterwards, so a
   * tenant can never see another tenant's knowledge even under a ranking bug.
   */
  async retrieve(
    organizationId: string,
    query: string,
    { limit = 12, minSimilarity = 0.15 }: { limit?: number; minSimilarity?: number } = {},
  ): Promise<RetrievedChunk[]> {
    const { vectors } = await this.ai.embed([query]);
    const vector = vectors[0];
    if (!vector || vector.length === 0) return [];

    const literal = toPostgresVector(vector);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        content: string;
        entityType: KnowledgeEntityType;
        entityId: string | null;
        sourceDocumentId: string | null;
        similarity: number;
      }>
    >(Prisma.sql`
      SELECT
        "id",
        "content",
        "entityType"::text AS "entityType",
        "entityId",
        "sourceDocumentId",
        kult_cosine_similarity("embedding", ${literal}::double precision[]) AS "similarity"
      FROM "KnowledgeChunk"
      WHERE "organizationId" = ${organizationId}
      ORDER BY "similarity" DESC
      LIMIT ${limit}
    `);

    return rows
      .filter((row) => Number(row.similarity) >= minSimilarity)
      .map((row) => ({ ...row, similarity: Number(row.similarity) }));
  }

  /** Removes every chunk derived from a source document or entity. */
  async remove(
    organizationId: string,
    filter: { sourceDocumentId?: string; entityType?: KnowledgeEntityType; entityId?: string },
  ): Promise<number> {
    const result = await this.prisma.knowledgeChunk.deleteMany({
      where: {
        organizationId,
        ...(filter.sourceDocumentId ? { sourceDocumentId: filter.sourceDocumentId } : {}),
        ...(filter.entityType ? { entityType: filter.entityType } : {}),
        ...(filter.entityId ? { entityId: filter.entityId } : {}),
      },
    });
    return result.count;
  }
}

/**
 * Renders a JS number array as a PostgreSQL array literal.
 *
 * The literal is passed as a bound parameter and cast in SQL, so no value is
 * interpolated into the statement text. Non-finite values would produce invalid
 * SQL, so they are rejected here rather than at the database.
 */
export function toPostgresVector(vector: number[]): string {
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error('Embedding contains a non-finite value and cannot be stored or queried.');
    }
  }
  return `{${vector.join(',')}}`;
}

/** Rough token estimate for budgeting context, not for billing. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
