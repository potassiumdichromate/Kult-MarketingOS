import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@kult/auth';
import type { AppConfig } from '@kult/config';
import { type PrismaClient, requireInOrg, scoped } from '@kult/database';
import {
  AgentRunner,
  ContentEditor,
  agents,
  type AIService,
  type BrandContextLoader,
  type KnowledgeBase,
} from '@kult/ai';
import {
  ConflictError,
  NotFoundError,
  QUEUE_NAMES,
  ValidationError,
  buildPage,
  canTransition,
  decodeCursor,
  getCapability,
  publishJobId,
  validateContent,
  type ContentStatus,
  type ContentType,
  type Page,
} from '@kult/shared';
import { AI_SERVICE, APP_CONFIG, BRAND_LOADER, KNOWLEDGE_BASE, PRISMA } from '../../common/tokens.js';
import { QueuesService } from '../../common/queues.service.js';

/**
 * Content lifecycle.
 *
 * The state machine in @kult/shared is the authority on what transitions are
 * legal; this service never mutates `status` without going through it. That is
 * what makes "content cannot be published without passing approval" a property
 * of the system rather than of any particular caller.
 */
@Injectable()
export class ContentService {
  private readonly agentRunner: AgentRunner;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AI_SERVICE) private readonly ai: AIService,
    @Inject(BRAND_LOADER) private readonly brand: BrandContextLoader,
    @Inject(KNOWLEDGE_BASE) private readonly knowledge: KnowledgeBase,
    private readonly queues: QueuesService,
  ) {
    this.agentRunner = new AgentRunner(prisma);
  }

  private agentContext(auth: AuthContext) {
    return {
      organizationId: auth.organizationId,
      prisma: this.prisma,
      ai: this.ai,
      brand: this.brand,
      knowledge: this.knowledge,
      correlationId: auth.requestId,
      triggeredByUserId: auth.userId,
    };
  }

  async list(
    auth: AuthContext,
    query: {
      status?: ContentStatus;
      contentType?: ContentType;
      campaignId?: string;
      scheduledFrom?: Date;
      scheduledTo?: Date;
      cursor?: string;
      limit: number;
    },
  ): Promise<Page<Record<string, unknown>>> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) {
      throw new ValidationError('Invalid cursor.', [{ path: 'cursor', message: 'Malformed cursor.' }]);
    }

    const rows = await this.prisma.contentItem.findMany({
      where: scoped(auth, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.contentType ? { contentType: query.contentType } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        ...(query.scheduledFrom || query.scheduledTo
          ? {
              scheduledAt: {
                ...(query.scheduledFrom ? { gte: query.scheduledFrom } : {}),
                ...(query.scheduledTo ? { lte: query.scheduledTo } : {}),
              },
            }
          : {}),
        // Keyset pagination on (createdAt, id).
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: contentListSelect,
    });

    return buildPage(rows, query.limit);
  }

  async get(auth: AuthContext, id: string) {
    const item = await this.prisma.contentItem.findUnique({
      where: { id },
      select: contentDetailSelect,
    });
    return requireInOrg(item, auth, 'Content item');
  }

  async create(
    auth: AuthContext,
    input: {
      contentType: ContentType;
      title?: string;
      body: string;
      threadParts?: string[];
      hashtags?: string[];
      mentions?: string[];
      cta?: string;
      campaignId?: string;
      opportunityId?: string;
    },
  ) {
    await this.assertRelationsInOrg(auth, input.campaignId, input.opportunityId);

    const capability = getCapability(input.contentType);

    return this.prisma.$transaction(async (tx) => {
      const item = await tx.contentItem.create({
        data: {
          organizationId: auth.organizationId,
          contentType: input.contentType,
          platform: capability.provider,
          title: input.title ?? null,
          body: input.body,
          threadParts: input.threadParts ?? [],
          hashtags: input.hashtags ?? [],
          mentions: input.mentions ?? [],
          cta: input.cta ?? null,
          campaignId: input.campaignId ?? null,
          opportunityId: input.opportunityId ?? null,
          status: 'DRAFT',
          createdById: auth.userId,
          version: 1,
        },
        select: contentDetailSelect,
      });

      await tx.contentVersion.create({
        data: {
          contentItemId: item.id,
          version: 1,
          body: input.body,
          threadParts: input.threadParts ?? [],
          hashtags: input.hashtags ?? [],
          mentions: input.mentions ?? [],
          cta: input.cta ?? null,
          createdById: auth.userId,
          changeSummary: 'Created',
        },
      });

      return item;
    });
  }

  /**
   * Applies an edit and snapshots a new version.
   *
   * Version increments matter beyond history: the version is part of the
   * publishing idempotency key, so editing approved content produces a genuinely
   * new publishable identity rather than colliding with the previous attempt.
   */
  async update(
    auth: AuthContext,
    id: string,
    input: {
      title?: string | null;
      body?: string;
      threadParts?: string[];
      hashtags?: string[];
      mentions?: string[];
      cta?: string | null;
      changeSummary?: string;
    },
  ) {
    const existing = await this.get(auth, id);

    if (existing.status === 'PUBLISHED') {
      throw new ConflictError('Published content cannot be edited. Duplicate it instead.');
    }
    if (existing.status === 'PUBLISHING') {
      throw new ConflictError('This content is currently publishing and cannot be edited.');
    }

    const substantive =
      input.body !== undefined ||
      input.threadParts !== undefined ||
      input.hashtags !== undefined ||
      input.cta !== undefined;

    const nextVersion = substantive ? existing.version + 1 : existing.version;

    return this.prisma.$transaction(async (tx) => {
      const item = await tx.contentItem.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.threadParts !== undefined ? { threadParts: input.threadParts } : {}),
          ...(input.hashtags !== undefined ? { hashtags: input.hashtags } : {}),
          ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
          ...(input.cta !== undefined ? { cta: input.cta } : {}),
          ...(substantive ? { version: nextVersion } : {}),
          // Editing approved or scheduled content invalidates the approval.
          ...(substantive && ['APPROVED', 'SCHEDULED', 'REJECTED'].includes(existing.status)
            ? { status: 'DRAFT' as const, scheduledAt: null }
            : {}),
        },
        select: contentDetailSelect,
      });

      if (substantive) {
        await tx.contentVersion.create({
          data: {
            contentItemId: id,
            version: nextVersion,
            body: item.body,
            threadParts: item.threadParts,
            hashtags: item.hashtags,
            mentions: item.mentions,
            cta: item.cta,
            createdById: auth.userId,
            changeSummary: input.changeSummary ?? 'Edited',
          },
        });
      }

      return item;
    }).then(async (item) => {
      // A scheduled job for the old version must not fire against edited copy.
      if (substantive && existing.status === 'SCHEDULED') {
        await this.queues.remove(
          QUEUE_NAMES.publishing,
          publishJobId(id, existing.version),
        );
      }
      return item;
    });
  }

  /** Generates copy with the ContentCreationAgent and stores it as a new version. */
  async generate(
    auth: AuthContext,
    id: string,
    input: { brief?: string; regenerate?: boolean },
  ) {
    const existing = await this.get(auth, id);
    if (existing.status === 'PUBLISHED' || existing.status === 'PUBLISHING') {
      throw new ConflictError('Content that is publishing or published cannot be regenerated.');
    }

    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: auth.organizationId },
      select: { automationMode: true },
    });

    const { output, executionId } = await this.agentRunner.run(
      agents.ContentCreationAgent,
      this.agentContext(auth),
      {
        contentType: existing.contentType,
        brief: input.brief ?? existing.body ?? existing.title ?? '',
        organizationRequiresApprovalAlways: organization.automationMode === 'MANUAL',
      },
    );

    const nextVersion = existing.version + 1;

    return this.prisma.$transaction(async (tx) => {
      const item = await tx.contentItem.update({
        where: { id },
        data: {
          body: output.body,
          threadParts: output.threadParts,
          hashtags: output.hashtags,
          mentions: output.mentions,
          cta: output.cta,
          ...(output.title ? { title: output.title } : {}),
          riskLevel: output.riskLevel,
          flaggedTopics: output.flaggedTopics,
          requiresApproval: output.requiresApproval,
          factualClaims: output.verifiedClaims as unknown as object,
          version: nextVersion,
          status: 'DRAFT',
          scheduledAt: null,
          createdByAgent: 'ContentCreationAgent',
          createdByExecutionId: executionId,
        },
        select: contentDetailSelect,
      });

      await tx.contentVersion.create({
        data: {
          contentItemId: id,
          version: nextVersion,
          body: output.body,
          threadParts: output.threadParts,
          hashtags: output.hashtags,
          mentions: output.mentions,
          cta: output.cta,
          rationale: output.rationale,
          factualClaims: output.verifiedClaims as unknown as object,
          createdByAgent: 'ContentCreationAgent',
          changeSummary: 'Generated by ContentCreationAgent',
        },
      });

      return {
        content: item,
        generation: {
          rationale: output.rationale,
          approvalReasons: output.approvalReasons,
          platformViolations: output.platformViolations,
          verifiedClaims: output.verifiedClaims,
          executionId,
        },
      };
    });
  }

  /** Studio operations: rewrite, shorten, expand, tone, CTA, hooks, checks. */
  async assist(
    auth: AuthContext,
    id: string,
    operation:
      | 'REWRITE'
      | 'SHORTEN'
      | 'EXPAND'
      | 'CHANGE_TONE'
      | 'GENERATE_CTA'
      | 'GENERATE_HOOKS'
      | 'BRAND_CHECK'
      | 'FACT_CHECK',
    options: { tone?: string; count?: number },
  ) {
    const existing = await this.get(auth, id);
    const editor = new ContentEditor(this.agentContext(auth));

    if (operation === 'GENERATE_HOOKS') {
      return editor.generateHooks({
        body: existing.body,
        contentType: existing.contentType,
        count: options.count ?? 5,
      });
    }
    if (operation === 'BRAND_CHECK') {
      return editor.brandCheck(existing.body);
    }
    if (operation === 'FACT_CHECK') {
      return editor.factCheck(existing.body);
    }

    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: auth.organizationId },
      select: { automationMode: true },
    });

    // Rewrites are returned for review rather than written straight to the item,
    // so the editor decides whether to keep them.
    return editor.rewrite({
      contentType: existing.contentType,
      body: existing.body,
      threadParts: existing.threadParts,
      hashtags: existing.hashtags,
      cta: existing.cta,
      operation,
      ...(options.tone ? { tone: options.tone } : {}),
      organizationRequiresApprovalAlways: organization.automationMode === 'MANUAL',
    });
  }

  async submitForApproval(auth: AuthContext, id: string) {
    return this.transition(auth, id, 'PENDING_APPROVAL');
  }

  async approve(auth: AuthContext, id: string, comment?: string) {
    const existing = await this.get(auth, id);
    if (!canTransition(existing.status, 'APPROVED')) {
      throw new ConflictError(`Content in status ${existing.status} cannot be approved.`);
    }

    // Approval is meaningless if the copy cannot legally be published.
    const violations = validateContent(
      {
        contentType: existing.contentType,
        body: existing.body,
        hashtags: existing.hashtags,
        threadParts: existing.threadParts,
        mediaCount: existing.mediaAssets.length,
      },
      { forPublishing: false },
    );
    if (violations.length > 0) {
      throw new ValidationError(
        'This content violates its platform constraints and cannot be approved.',
        violations.map((violation) => ({ path: violation.field, message: violation.message })),
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.contentApproval.create({
        data: {
          contentItemId: id,
          reviewerId: auth.userId,
          decision: 'APPROVED',
          comment: comment ?? null,
        },
      });
      return tx.contentItem.update({
        where: { id },
        data: { status: 'APPROVED' },
        select: contentDetailSelect,
      });
    });
  }

  async reject(auth: AuthContext, id: string, comment: string) {
    const existing = await this.get(auth, id);
    if (!canTransition(existing.status, 'REJECTED')) {
      throw new ConflictError(`Content in status ${existing.status} cannot be rejected.`);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.contentApproval.create({
        data: {
          contentItemId: id,
          reviewerId: auth.userId,
          decision: 'REJECTED',
          comment,
        },
      });
      return tx.contentItem.update({
        where: { id },
        data: { status: 'REJECTED' },
        select: contentDetailSelect,
      });
    });
  }

  /**
   * Schedules content for future publication.
   *
   * The database record is written first and the delayed job carries a
   * deterministic id derived from (contentItemId, version). Reconciliation can
   * therefore detect a scheduled item whose queue job went missing - for example
   * after a Redis flush - and restore it.
   */
  async schedule(auth: AuthContext, id: string, scheduledAt: Date) {
    const existing = await this.get(auth, id);
    if (!canTransition(existing.status, 'SCHEDULED')) {
      throw new ConflictError(
        `Content in status ${existing.status} cannot be scheduled. It must be APPROVED first.`,
      );
    }
    if (scheduledAt.getTime() <= Date.now()) {
      throw new ValidationError('The scheduled time must be in the future.', [
        { path: 'scheduledAt', message: 'Pick a time later than now.' },
      ]);
    }

    const connection = await this.resolveConnection(auth, existing.contentType);

    const item = await this.prisma.contentItem.update({
      where: { id },
      data: { status: 'SCHEDULED', scheduledAt },
      select: contentDetailSelect,
    });

    await this.queues.enqueue(
      QUEUE_NAMES.publishing,
      'publish-content',
      {
        contentItemId: id,
        organizationId: auth.organizationId,
        socialConnectionId: connection.id,
        contentVersion: item.version,
        actorUserId: auth.userId,
        correlationId: auth.requestId,
      },
      {
        jobId: publishJobId(id, item.version),
        delayMs: scheduledAt.getTime() - Date.now(),
        attempts: 5,
      },
    );

    return item;
  }

  /** Requests immediate publication. The worker performs it. */
  async publishNow(auth: AuthContext, id: string) {
    const existing = await this.get(auth, id);
    if (!canTransition(existing.status, 'PUBLISHING')) {
      throw new ConflictError(
        `Content in status ${existing.status} cannot be published. It must be APPROVED or SCHEDULED.`,
      );
    }

    const violations = validateContent(
      {
        contentType: existing.contentType,
        body: existing.body,
        hashtags: existing.hashtags,
        threadParts: existing.threadParts,
        mediaCount: existing.mediaAssets.length,
      },
      { forPublishing: true },
    );
    if (violations.length > 0) {
      throw new ValidationError(
        'This content cannot be published as it stands.',
        violations.map((violation) => ({ path: violation.field, message: violation.message })),
      );
    }

    const connection = await this.resolveConnection(auth, existing.contentType);

    await this.queues.enqueue(
      QUEUE_NAMES.publishing,
      'publish-content',
      {
        contentItemId: id,
        organizationId: auth.organizationId,
        socialConnectionId: connection.id,
        contentVersion: existing.version,
        actorUserId: auth.userId,
        correlationId: auth.requestId,
      },
      { jobId: publishJobId(id, existing.version), attempts: 5 },
    );

    return { queued: true, contentItemId: id, contentVersion: existing.version };
  }

  async cancel(auth: AuthContext, id: string) {
    const existing = await this.get(auth, id);
    if (!canTransition(existing.status, 'CANCELLED')) {
      throw new ConflictError(`Content in status ${existing.status} cannot be cancelled.`);
    }

    await this.queues.remove(QUEUE_NAMES.publishing, publishJobId(id, existing.version));

    return this.prisma.contentItem.update({
      where: { id },
      data: { status: 'CANCELLED', scheduledAt: null },
      select: contentDetailSelect,
    });
  }

  async delete(auth: AuthContext, id: string): Promise<void> {
    const existing = await this.get(auth, id);
    if (existing.status === 'PUBLISHED') {
      throw new ConflictError(
        'Published content cannot be deleted; its publication record must be retained for audit.',
      );
    }
    if (existing.status === 'PUBLISHING') {
      throw new ConflictError('Content that is currently publishing cannot be deleted.');
    }

    await this.queues.remove(QUEUE_NAMES.publishing, publishJobId(id, existing.version));
    await this.prisma.contentItem.delete({ where: { id } });
  }

  async versions(auth: AuthContext, id: string) {
    await this.get(auth, id);
    return this.prisma.contentVersion.findMany({
      where: { contentItemId: id },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        body: true,
        threadParts: true,
        hashtags: true,
        cta: true,
        rationale: true,
        changeSummary: true,
        createdByAgent: true,
        createdAt: true,
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
    });
  }

  /** Generic guarded status change for transitions with no extra side effects. */
  private async transition(auth: AuthContext, id: string, next: ContentStatus) {
    const existing = await this.get(auth, id);
    if (!canTransition(existing.status, next)) {
      throw new ConflictError(`Cannot move content from ${existing.status} to ${next}.`);
    }
    return this.prisma.contentItem.update({
      where: { id },
      data: { status: next },
      select: contentDetailSelect,
    });
  }

  /**
   * Finds the active social connection able to publish this content type.
   * Refuses clearly rather than letting the worker discover the problem later.
   */
  private async resolveConnection(auth: AuthContext, contentType: ContentType) {
    const capability = getCapability(contentType);
    if (!capability.publishable || !capability.provider) {
      throw new ValidationError(
        capability.requirement ?? `${contentType} cannot be published from this deployment.`,
        [{ path: 'contentType', message: capability.requirement ?? 'Not publishable.' }],
      );
    }

    const connection = await this.prisma.socialConnection.findFirst({
      where: {
        organizationId: auth.organizationId,
        provider: capability.provider,
        status: 'ACTIVE',
      },
      select: { id: true, provider: true, capabilities: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!connection) {
      throw new ValidationError(
        `No active ${capability.provider} connection is available for this organization.`,
        [
          {
            path: 'socialConnection',
            message: `Connect a ${capability.provider} account under Integrations before publishing.`,
          },
        ],
      );
    }

    const publishable = (connection.capabilities as { publishableContentTypes?: string[] } | null)
      ?.publishableContentTypes;
    if (Array.isArray(publishable) && !publishable.includes(contentType)) {
      throw new ValidationError(
        `The connected ${capability.provider} account cannot publish ${contentType}.`,
        [
          {
            path: 'socialConnection',
            message:
              'Open Integrations to see which capabilities this connection has and what is missing.',
          },
        ],
      );
    }

    return connection;
  }

  private async assertRelationsInOrg(
    auth: AuthContext,
    campaignId?: string,
    opportunityId?: string,
  ): Promise<void> {
    if (campaignId) {
      const campaign = await this.prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { organizationId: true },
      });
      if (!campaign || campaign.organizationId !== auth.organizationId) {
        throw new NotFoundError('Campaign');
      }
    }
    if (opportunityId) {
      const opportunity = await this.prisma.opportunity.findUnique({
        where: { id: opportunityId },
        select: { organizationId: true },
      });
      if (!opportunity || opportunity.organizationId !== auth.organizationId) {
        throw new NotFoundError('Opportunity');
      }
    }
  }
}

const contentListSelect = {
  id: true,
  organizationId: true,
  contentType: true,
  platform: true,
  title: true,
  body: true,
  status: true,
  riskLevel: true,
  flaggedTopics: true,
  requiresApproval: true,
  scheduledAt: true,
  publishedAt: true,
  version: true,
  campaignId: true,
  opportunityId: true,
  createdByAgent: true,
  createdAt: true,
  updatedAt: true,
} as const;

const contentDetailSelect = {
  ...contentListSelect,
  threadParts: true,
  hashtags: true,
  mentions: true,
  cta: true,
  factualClaims: true,
  createdBy: { select: { id: true, displayName: true, email: true } },
  mediaAssets: {
    select: {
      order: true,
      brandAsset: {
        select: { id: true, name: true, mimeType: true, publicUrl: true, width: true, height: true },
      },
    },
    orderBy: { order: 'asc' as const },
  },
  approvals: {
    select: {
      id: true,
      decision: true,
      comment: true,
      createdAt: true,
      reviewer: { select: { id: true, displayName: true, email: true } },
    },
    orderBy: { createdAt: 'desc' as const },
    take: 20,
  },
  publications: {
    select: {
      id: true,
      provider: true,
      status: true,
      providerPostId: true,
      providerUrl: true,
      publishedAt: true,
      attempts: true,
      errorCode: true,
      errorMessage: true,
    },
    orderBy: { createdAt: 'desc' as const },
    take: 10,
  },
} as const;
