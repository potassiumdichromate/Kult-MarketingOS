import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@kult/auth';
import { type PrismaClient, requireInOrg, scoped } from '@kult/database';
import { KnowledgeBase, chunkText } from '@kult/ai';
import { safeFetch, stripHtml, type StorageAdapter } from '@kult/integrations';
import { NotConfiguredError, QUEUE_NAMES, ValidationError } from '@kult/shared';
import { KNOWLEDGE_BASE, PRISMA, STORAGE } from '../../common/tokens.js';
import { QueuesService } from '../../common/queues.service.js';

/**
 * Brand knowledge base management.
 *
 * The ingestion pipeline is: source -> extract -> normalise -> chunk -> embed ->
 * persist -> searchable. Structured entities (products, audiences, claims) are
 * indexed synchronously because they are small. Documents and URLs are indexed
 * on the worker, because fetching and embedding a long document is slow and
 * belongs off the request path.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(KNOWLEDGE_BASE) private readonly knowledge: KnowledgeBase,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
    private readonly queues: QueuesService,
  ) {}

  /** The full structured brand knowledge for the settings screens. */
  async overview(auth: AuthContext) {
    const [
      profile,
      products,
      features,
      audiences,
      competitors,
      approvedClaims,
      forbiddenClaims,
      guidelines,
      documents,
      chunkCount,
    ] = await Promise.all([
      this.prisma.brandProfile.findUnique({ where: { organizationId: auth.organizationId } }),
      this.prisma.product.findMany({ where: scoped(auth), orderBy: { createdAt: 'asc' } }),
      this.prisma.feature.findMany({ where: scoped(auth), orderBy: { createdAt: 'asc' } }),
      this.prisma.audience.findMany({ where: scoped(auth), orderBy: { createdAt: 'asc' } }),
      this.prisma.competitor.findMany({ where: scoped(auth), orderBy: { createdAt: 'asc' } }),
      this.prisma.approvedClaim.findMany({ where: scoped(auth), orderBy: { createdAt: 'desc' } }),
      this.prisma.forbiddenClaim.findMany({ where: scoped(auth), orderBy: { createdAt: 'desc' } }),
      this.prisma.brandGuideline.findMany({ where: scoped(auth), orderBy: { category: 'asc' } }),
      this.prisma.sourceDocument.findMany({
        where: scoped(auth),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          sourceType: true,
          sourceUrl: true,
          status: true,
          chunkCount: true,
          extractedChars: true,
          error: true,
          createdAt: true,
        },
      }),
      this.prisma.knowledgeChunk.count({ where: scoped(auth) }),
    ]);

    return {
      profile,
      products,
      features,
      audiences,
      competitors,
      approvedClaims,
      forbiddenClaims,
      guidelines,
      documents,
      indexedChunks: chunkCount,
    };
  }

  /** Semantic search over the knowledge base, used by the studio and the copilot. */
  async search(auth: AuthContext, query: string, limit: number) {
    return this.knowledge.retrieve(auth.organizationId, query, { limit });
  }

  async upsertProfile(
    auth: AuthContext,
    input: {
      description: string;
      positioning?: string | null;
      mission?: string | null;
      voiceSummary?: string | null;
      toneAttributes?: string[];
      writingRules?: string[];
      bannedPhrases?: string[];
    },
  ) {
    const profile = await this.prisma.brandProfile.upsert({
      where: { organizationId: auth.organizationId },
      create: {
        organizationId: auth.organizationId,
        description: input.description,
        positioning: input.positioning ?? null,
        mission: input.mission ?? null,
        voiceSummary: input.voiceSummary ?? null,
        toneAttributes: input.toneAttributes ?? [],
        writingRules: input.writingRules ?? [],
        bannedPhrases: input.bannedPhrases ?? [],
      },
      update: {
        description: input.description,
        ...(input.positioning !== undefined ? { positioning: input.positioning } : {}),
        ...(input.mission !== undefined ? { mission: input.mission } : {}),
        ...(input.voiceSummary !== undefined ? { voiceSummary: input.voiceSummary } : {}),
        ...(input.toneAttributes !== undefined ? { toneAttributes: input.toneAttributes } : {}),
        ...(input.writingRules !== undefined ? { writingRules: input.writingRules } : {}),
        ...(input.bannedPhrases !== undefined ? { bannedPhrases: input.bannedPhrases } : {}),
      },
    });

    // Re-index so retrieval reflects the edit immediately.
    await this.knowledge.remove(auth.organizationId, { entityType: 'BRAND_PROFILE' });
    await this.knowledge.index(auth.organizationId, [
      {
        entityType: 'BRAND_PROFILE',
        entityId: profile.id,
        content: [
          `Brand description: ${profile.description}`,
          profile.positioning ? `Positioning: ${profile.positioning}` : '',
          profile.mission ? `Mission: ${profile.mission}` : '',
          profile.voiceSummary ? `Voice: ${profile.voiceSummary}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ]);

    return profile;
  }

  /**
   * Creates a knowledge entity and indexes it.
   *
   * The entity types are handled explicitly rather than through a generic table
   * write so each one is indexed with text that reads well when retrieved.
   */
  async createEntity(
    auth: AuthContext,
    input:
      | { type: 'PRODUCT'; name: string; description: string; url?: string }
      | { type: 'FEATURE'; name: string; description: string; productId?: string }
      | { type: 'AUDIENCE'; name: string; description: string; painPoints?: string[]; channels?: string[] }
      | { type: 'COMPETITOR'; name: string; websiteUrl?: string; notes?: string }
      | { type: 'APPROVED_CLAIM'; claim: string; evidenceUrl?: string; expiresAt?: Date }
      | { type: 'FORBIDDEN_CLAIM'; claim: string; reason: string }
      | { type: 'GUIDELINE'; category: string; rule: string; severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' },
  ) {
    switch (input.type) {
      case 'PRODUCT': {
        const row = await this.prisma.product.create({
          data: {
            organizationId: auth.organizationId,
            name: input.name,
            description: input.description,
            url: input.url ?? null,
          },
        });
        await this.index('PRODUCT', row.id, auth, `Product ${row.name}: ${row.description}`);
        return row;
      }
      case 'FEATURE': {
        const row = await this.prisma.feature.create({
          data: {
            organizationId: auth.organizationId,
            name: input.name,
            description: input.description,
            productId: input.productId ?? null,
          },
        });
        await this.index('FEATURE', row.id, auth, `Feature ${row.name}: ${row.description}`);
        return row;
      }
      case 'AUDIENCE': {
        const row = await this.prisma.audience.create({
          data: {
            organizationId: auth.organizationId,
            name: input.name,
            description: input.description,
            painPoints: input.painPoints ?? [],
            channels: input.channels ?? [],
          },
        });
        await this.index(
          'AUDIENCE',
          row.id,
          auth,
          `Audience ${row.name}: ${row.description}. Pain points: ${row.painPoints.join('; ')}`,
        );
        return row;
      }
      case 'COMPETITOR': {
        const row = await this.prisma.competitor.create({
          data: {
            organizationId: auth.organizationId,
            name: input.name,
            websiteUrl: input.websiteUrl ?? null,
            notes: input.notes ?? null,
          },
        });
        await this.index(
          'COMPETITOR',
          row.id,
          auth,
          `Competitor ${row.name}. ${row.notes ?? ''}`.trim(),
        );
        return row;
      }
      case 'APPROVED_CLAIM': {
        const row = await this.prisma.approvedClaim.create({
          data: {
            organizationId: auth.organizationId,
            claim: input.claim,
            evidenceUrl: input.evidenceUrl ?? null,
            expiresAt: input.expiresAt ?? null,
            approvedById: auth.userId,
          },
        });
        await this.index('APPROVED_CLAIM', row.id, auth, `Approved claim: ${row.claim}`);
        return row;
      }
      case 'FORBIDDEN_CLAIM':
        return this.prisma.forbiddenClaim.create({
          data: {
            organizationId: auth.organizationId,
            claim: input.claim,
            reason: input.reason,
          },
        });
      case 'GUIDELINE': {
        const row = await this.prisma.brandGuideline.create({
          data: {
            organizationId: auth.organizationId,
            category: input.category,
            rule: input.rule,
            severity: input.severity ?? 'MEDIUM',
          },
        });
        await this.index('BRAND_GUIDELINE', row.id, auth, `${row.category}: ${row.rule}`);
        return row;
      }
    }
  }

  /**
   * Ingests a URL as a source document.
   *
   * The URL is user-supplied, so it is fetched through the SSRF-guarded client.
   * Extraction happens here (it is fast); embedding is enqueued.
   */
  async ingestUrl(auth: AuthContext, url: string, title?: string) {
    const response = await safeFetch(url, {
      headers: { accept: 'text/html,application/xhtml+xml,text/plain' },
      maxBytes: 3 * 1024 * 1024,
      timeoutMs: 20_000,
    });

    const text = stripHtml(response.body);
    if (text.length < 50) {
      throw new ValidationError('That page produced almost no readable text.', [
        { path: 'url', message: 'Nothing substantial could be extracted from this URL.' },
      ]);
    }

    const document = await this.prisma.sourceDocument.create({
      data: {
        organizationId: auth.organizationId,
        title: title ?? extractTitle(response.body) ?? url,
        sourceType: 'URL',
        sourceUrl: response.url,
        status: 'PENDING',
        extractedChars: text.length,
      },
      select: { id: true, title: true, status: true },
    });

    await this.queues.enqueue(
      QUEUE_NAMES.content,
      'index-document',
      {
        organizationId: auth.organizationId,
        sourceDocumentId: document.id,
        text,
        correlationId: auth.requestId,
      },
      { jobId: `index:${document.id}` },
    );

    return document;
  }

  /** Ingests an uploaded document. Requires object storage to be configured. */
  async ingestUpload(
    auth: AuthContext,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ) {
    if (!this.storage.configured) {
      throw new NotConfiguredError('Document upload', [
        'STORAGE_ENDPOINT',
        'STORAGE_REGION',
        'STORAGE_BUCKET',
        'STORAGE_ACCESS_KEY',
        'STORAGE_SECRET_KEY',
      ]);
    }

    // Only formats whose text can genuinely be extracted are accepted; a PDF or
    // Word file would be stored but never indexed, which would be misleading.
    const supported = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
    if (!supported.includes(file.mimetype)) {
      throw new ValidationError(`Unsupported document type "${file.mimetype}".`, [
        {
          path: 'file',
          message:
            `Supported types are: ${supported.join(', ')}. For a PDF or Word document, paste its ` +
            'text or publish it at a URL and add that URL instead.',
        },
      ]);
    }

    const stored = await this.storage.put({
      body: file.buffer,
      contentType: file.mimetype,
      key: `knowledge/${auth.organizationId}/${Date.now()}-${sanitizeFilename(file.originalname)}`,
    });

    const text = file.buffer.toString('utf8');

    const document = await this.prisma.sourceDocument.create({
      data: {
        organizationId: auth.organizationId,
        title: file.originalname,
        sourceType: 'UPLOAD',
        storageKey: stored.key,
        mimeType: file.mimetype,
        status: 'PENDING',
        extractedChars: text.length,
      },
      select: { id: true, title: true, status: true },
    });

    await this.queues.enqueue(
      QUEUE_NAMES.content,
      'index-document',
      {
        organizationId: auth.organizationId,
        sourceDocumentId: document.id,
        text,
        correlationId: auth.requestId,
      },
      { jobId: `index:${document.id}` },
    );

    return document;
  }

  /** Adds free text directly, indexed synchronously since it is short. */
  async ingestText(auth: AuthContext, title: string, text: string) {
    const document = await this.prisma.sourceDocument.create({
      data: {
        organizationId: auth.organizationId,
        title,
        sourceType: 'TEXT',
        status: 'PROCESSING',
        extractedChars: text.length,
      },
      select: { id: true, title: true },
    });

    const chunks = chunkText(text);
    const written = await this.knowledge.index(
      auth.organizationId,
      chunks.map((content, index) => ({
        entityType: 'SOURCE_DOCUMENT' as const,
        sourceDocumentId: document.id,
        content,
        chunkIndex: index,
      })),
    );

    return this.prisma.sourceDocument.update({
      where: { id: document.id },
      data: { status: 'INDEXED', chunkCount: written },
      select: { id: true, title: true, status: true, chunkCount: true },
    });
  }

  async deleteDocument(auth: AuthContext, id: string): Promise<void> {
    const document = await this.prisma.sourceDocument.findUnique({
      where: { id },
      select: { id: true, organizationId: true, storageKey: true },
    });
    const found = requireInOrg(document, auth, 'Source document');

    if (found.storageKey && this.storage.configured) {
      await this.storage.delete(found.storageKey).catch(() => undefined);
    }
    // Chunks cascade from the document row.
    await this.prisma.sourceDocument.delete({ where: { id } });
  }

  /** Deletes a structured knowledge entity and its index entries. */
  async deleteEntity(
    auth: AuthContext,
    type: 'PRODUCT' | 'FEATURE' | 'AUDIENCE' | 'COMPETITOR' | 'APPROVED_CLAIM' | 'FORBIDDEN_CLAIM' | 'GUIDELINE',
    id: string,
  ): Promise<void> {
    const table = {
      PRODUCT: this.prisma.product,
      FEATURE: this.prisma.feature,
      AUDIENCE: this.prisma.audience,
      COMPETITOR: this.prisma.competitor,
      APPROVED_CLAIM: this.prisma.approvedClaim,
      FORBIDDEN_CLAIM: this.prisma.forbiddenClaim,
      GUIDELINE: this.prisma.brandGuideline,
    }[type];

    const row = await (table as { findUnique: (args: unknown) => Promise<{ organizationId: string } | null> })
      .findUnique({ where: { id }, select: { organizationId: true } });
    requireInOrg(row, auth, type);

    await (table as { delete: (args: unknown) => Promise<unknown> }).delete({ where: { id } });

    const entityType = type === 'GUIDELINE' ? 'BRAND_GUIDELINE' : type;
    if (entityType !== 'FORBIDDEN_CLAIM') {
      await this.knowledge.remove(auth.organizationId, {
        entityType: entityType as never,
        entityId: id,
      });
    }
  }

  private async index(
    entityType: 'PRODUCT' | 'FEATURE' | 'AUDIENCE' | 'COMPETITOR' | 'APPROVED_CLAIM' | 'BRAND_GUIDELINE',
    entityId: string,
    auth: AuthContext,
    content: string,
  ): Promise<void> {
    await this.knowledge.index(auth.organizationId, [{ entityType, entityId, content }]);
  }
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? stripHtml(match[1]).slice(0, 300) : undefined;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}
