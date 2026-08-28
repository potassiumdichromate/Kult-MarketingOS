import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@kult/database';
import { scoped } from '@kult/database';
import { CopilotToolRegistry, KnowledgeBase, toolSchemas } from '@kult/ai';
import { QUEUE_NAMES, publishJobId, getCapability, canTransition, ConflictError } from '@kult/shared';
import { KNOWLEDGE_BASE, PRISMA } from '../../common/tokens.js';
import { QueuesService } from '../../common/queues.service.js';
import { AuditService } from '../../common/audit.service.js';

/**
 * Concrete copilot tools.
 *
 * Each tool declares the permission it needs; the registry re-checks it against
 * the caller's role at invocation time. Every query is tenant-scoped from the
 * AuthContext - no tool takes an organizationId, so the model has no way to name
 * another tenant.
 *
 * The four side-effecting tools are marked requiresConfirmation, which means the
 * registry returns a proposal instead of acting until the user confirms it in a
 * subsequent request.
 */
@Injectable()
export class CopilotToolsFactory {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(KNOWLEDGE_BASE) private readonly knowledge: KnowledgeBase,
    private readonly queues: QueuesService,
    private readonly audit: AuditService,
  ) {}

  build(): CopilotToolRegistry {
    const registry = new CopilotToolRegistry();
    const prisma = this.prisma;

    registry.register({
      name: 'searchResearch',
      description:
        'Search collected research items by keyword. Returns real sources with their URLs.',
      parameters: toolSchemas.searchResearch,
      permission: 'research:read',
      requiresConfirmation: false,
      handler: async (input, context) =>
        prisma.researchItem.findMany({
          where: scoped(context.auth, {
            OR: [
              { title: { contains: input.query, mode: 'insensitive' as const } },
              { body: { contains: input.query, mode: 'insensitive' as const } },
            ],
          }),
          orderBy: { collectedAt: 'desc' },
          take: input.limit,
          select: {
            id: true,
            title: true,
            url: true,
            publishedAt: true,
            sourceType: true,
            engagement: true,
          },
        }),
    });

    registry.register({
      name: 'getTrendingTopics',
      description: 'List current trends with their deterministic scores and score components.',
      parameters: toolSchemas.getTrendingTopics,
      permission: 'research:read',
      requiresConfirmation: false,
      handler: async (input, context) =>
        prisma.trend.findMany({
          where: scoped(context.auth, { score: { gte: input.minScore } }),
          orderBy: { score: 'desc' },
          take: input.limit,
          select: {
            id: true,
            name: true,
            summary: true,
            score: true,
            components: true,
            status: true,
            rationale: true,
          },
        }),
    });

    registry.register({
      name: 'getNiches',
      description: 'List discovered micro-niches with their scores.',
      parameters: toolSchemas.getNiches,
      permission: 'research:read',
      requiresConfirmation: false,
      handler: async (input, context) =>
        prisma.niche.findMany({
          where: scoped(context.auth),
          orderBy: { score: 'desc' },
          take: input.limit,
          select: { id: true, name: true, description: true, rationale: true, score: true },
        }),
    });

    registry.register({
      name: 'getOpportunities',
      description: 'List marketing opportunities, highest scoring first.',
      parameters: toolSchemas.getOpportunities,
      permission: 'opportunities:read',
      requiresConfirmation: false,
      handler: async (input, context) =>
        prisma.opportunity.findMany({
          where: scoped(context.auth, { ...(input.status ? { status: input.status } : {}) }),
          orderBy: { opportunityScore: 'desc' },
          take: input.limit,
          select: {
            id: true,
            title: true,
            description: true,
            opportunityScore: true,
            platform: true,
            contentFormat: true,
            recommendedAction: true,
            status: true,
            expiresAt: true,
          },
        }),
    });

    registry.register({
      name: 'getBrandKnowledge',
      description:
        'Semantic search over the brand knowledge base. Use this before making any factual claim ' +
        'about the brand.',
      parameters: toolSchemas.getBrandKnowledge,
      permission: 'knowledge:read',
      requiresConfirmation: false,
      handler: async (input, context) =>
        this.knowledge.retrieve(context.auth.organizationId, input.query, { limit: input.limit }),
    });

    registry.register({
      name: 'getCampaigns',
      description: 'List campaigns with status and content counts.',
      parameters: toolSchemas.getCampaigns,
      permission: 'campaigns:read',
      requiresConfirmation: false,
      handler: async (input, context) =>
        prisma.campaign.findMany({
          where: scoped(context.auth, { ...(input.status ? { status: input.status } : {}) }),
          orderBy: { startDate: 'desc' },
          take: input.limit,
          select: {
            id: true,
            name: true,
            objective: true,
            status: true,
            startDate: true,
            endDate: true,
            platforms: true,
            _count: { select: { contentItems: true } },
          },
        }),
    });

    registry.register({
      name: 'getAnalytics',
      description: 'Aggregate performance for a period. Null metrics mean the provider did not report them.',
      parameters: toolSchemas.getAnalytics,
      permission: 'analytics:read',
      requiresConfirmation: false,
      handler: async (input, context) => {
        const since = new Date(Date.now() - input.periodDays * 86_400_000);
        const publications = await prisma.publication.findMany({
          where: scoped(context.auth, { status: 'SUCCEEDED' as const, publishedAt: { gte: since } }),
          select: {
            provider: true,
            publishedAt: true,
            contentItem: { select: { contentType: true, title: true } },
            metrics: {
              orderBy: { capturedAt: 'desc' },
              take: 1,
              select: { impressions: true, likes: true, comments: true, engagementRate: true },
            },
          },
        });
        return {
          periodDays: input.periodDays,
          postCount: publications.length,
          posts: publications.map((publication) => ({
            provider: publication.provider,
            contentType: publication.contentItem.contentType,
            title: publication.contentItem.title,
            publishedAt: publication.publishedAt,
            metrics: publication.metrics[0] ?? null,
          })),
        };
      },
    });

    registry.register({
      name: 'analyzePerformance',
      description:
        'Queue a full performance review that produces strategy insight proposals. Returns a ' +
        'workflow id; results appear under Insights.',
      parameters: toolSchemas.analyzePerformance,
      permission: 'analytics:read',
      requiresConfirmation: false,
      handler: async (input, context) => {
        const execution = await prisma.workflowExecution.create({
          data: {
            organizationId: context.auth.organizationId,
            workflowName: 'performance-review',
            status: 'PENDING',
            input: { periodDays: input.periodDays },
            correlationId: context.auth.requestId,
            triggeredById: context.auth.userId,
            triggeredByType: 'USER',
            steps: [],
          },
          select: { id: true },
        });
        await this.queues.enqueue(
          QUEUE_NAMES.analytics,
          'performance-review',
          {
            organizationId: context.auth.organizationId,
            workflowExecutionId: execution.id,
            periodDays: input.periodDays,
            triggeredByUserId: context.auth.userId,
            correlationId: context.auth.requestId,
          },
          { jobId: `review:${execution.id}` },
        );
        return { workflowExecutionId: execution.id, status: 'PENDING' };
      },
    });

    registry.register({
      name: 'getContentReadyToPublish',
      description: 'List approved content that is ready to schedule or publish.',
      parameters: toolSchemas.getContentReadyToPublish,
      permission: 'content:read',
      requiresConfirmation: false,
      handler: async (input, context) =>
        prisma.contentItem.findMany({
          where: scoped(context.auth, { status: 'APPROVED' as const }),
          orderBy: { updatedAt: 'desc' },
          take: input.limit,
          select: {
            id: true,
            title: true,
            contentType: true,
            body: true,
            riskLevel: true,
            version: true,
            updatedAt: true,
          },
        }),
    });

    // ---- Side-effecting tools: all confirmation-gated ----------------------

    registry.register({
      name: 'generateContent',
      description:
        'Create a draft content item and generate copy for it. The draft is never published; it ' +
        'appears in the content studio for review.',
      parameters: toolSchemas.generateContent,
      permission: 'ai:generate',
      requiresConfirmation: true,
      describeAction: (input) =>
        `Create a ${input.contentType} draft and generate copy for: "${input.brief.slice(0, 120)}"`,
      handler: async (input, context) => {
        const capability = getCapability(input.contentType);
        const item = await prisma.contentItem.create({
          data: {
            organizationId: context.auth.organizationId,
            contentType: input.contentType,
            platform: capability.provider,
            body: '',
            status: 'DRAFT',
            opportunityId: input.opportunityId ?? null,
            createdById: context.auth.userId,
            createdByAgent: 'MarketingCopilotAgent',
          },
          select: { id: true, contentType: true },
        });

        await this.queues.enqueue(
          QUEUE_NAMES.ai,
          'generate-content',
          {
            organizationId: context.auth.organizationId,
            contentItemId: item.id,
            brief: input.brief,
            triggeredByUserId: context.auth.userId,
            correlationId: context.auth.requestId,
          },
          { jobId: `gen:${item.id}` },
        );

        return {
          contentItemId: item.id,
          status: 'GENERATING',
          message: 'A draft was created and generation was queued. It will appear in Content.',
        };
      },
    });

    registry.register({
      name: 'createCampaign',
      description: 'Create a campaign and queue generation of its strategy and calendar.',
      parameters: toolSchemas.createCampaign,
      permission: 'campaigns:write',
      requiresConfirmation: true,
      describeAction: (input) =>
        `Create a ${input.durationDays}-day campaign on ${input.platforms.join(', ')} for: "${input.goal.slice(0, 120)}"`,
      handler: async (input, context) => {
        const startDate = new Date();
        const endDate = new Date(startDate.getTime() + input.durationDays * 86_400_000);

        const campaign = await prisma.campaign.create({
          data: {
            organizationId: context.auth.organizationId,
            name: input.goal.slice(0, 120),
            objective: input.goal,
            startDate,
            endDate,
            platforms: input.platforms,
            status: 'DRAFT',
            createdById: context.auth.userId,
          },
          select: { id: true, name: true },
        });

        const execution = await prisma.workflowExecution.create({
          data: {
            organizationId: context.auth.organizationId,
            workflowName: 'campaign-generation',
            status: 'PENDING',
            input: { campaignId: campaign.id },
            correlationId: context.auth.requestId,
            triggeredById: context.auth.userId,
            triggeredByType: 'USER',
            steps: [],
          },
          select: { id: true },
        });

        await this.queues.enqueue(
          QUEUE_NAMES.ai,
          'generate-campaign',
          {
            organizationId: context.auth.organizationId,
            campaignId: campaign.id,
            workflowExecutionId: execution.id,
            postsPerWeek: 5,
            opportunityIds: [],
            triggeredByUserId: context.auth.userId,
            correlationId: context.auth.requestId,
          },
          { jobId: `campaign:${execution.id}` },
        );

        return { campaignId: campaign.id, workflowExecutionId: execution.id, status: 'DRAFT' };
      },
    });

    registry.register({
      name: 'scheduleContent',
      description: 'Schedule approved content for publication at a specific time.',
      parameters: toolSchemas.scheduleContent,
      permission: 'content:schedule',
      requiresConfirmation: true,
      describeAction: (input) =>
        `Schedule content ${input.contentItemId} to publish at ${input.scheduledAtIso}`,
      handler: async (input, context) => {
        const item = await prisma.contentItem.findUnique({
          where: { id: input.contentItemId },
          select: { id: true, organizationId: true, status: true, version: true, contentType: true },
        });
        if (!item || item.organizationId !== context.auth.organizationId) {
          throw new Error('That content item was not found.');
        }
        if (!canTransition(item.status, 'SCHEDULED')) {
          throw new ConflictError(
            `Content in status ${item.status} cannot be scheduled; it must be APPROVED first.`,
          );
        }

        const scheduledAt = new Date(input.scheduledAtIso);
        if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
          throw new Error('scheduledAtIso must be a valid future timestamp.');
        }

        const capability = getCapability(item.contentType);
        const connection = await prisma.socialConnection.findFirst({
          where: {
            organizationId: context.auth.organizationId,
            provider: capability.provider ?? undefined,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (!connection) {
          throw new Error(
            `No active ${capability.provider} connection is available. Connect one under Integrations.`,
          );
        }

        await prisma.contentItem.update({
          where: { id: item.id },
          data: { status: 'SCHEDULED', scheduledAt },
        });

        await this.queues.enqueue(
          QUEUE_NAMES.publishing,
          'publish-content',
          {
            contentItemId: item.id,
            organizationId: context.auth.organizationId,
            socialConnectionId: connection.id,
            contentVersion: item.version,
            actorUserId: context.auth.userId,
            correlationId: context.auth.requestId,
          },
          {
            jobId: publishJobId(item.id, item.version),
            delayMs: scheduledAt.getTime() - Date.now(),
            attempts: 5,
          },
        );

        await this.audit.record({
          action: 'content.scheduled',
          organizationId: context.auth.organizationId,
          actorUserId: context.auth.userId,
          actorType: 'AGENT',
          resourceType: 'ContentItem',
          resourceId: item.id,
          metadata: { via: 'copilot', scheduledAt: scheduledAt.toISOString() },
        });

        return { contentItemId: item.id, scheduledAt, status: 'SCHEDULED' };
      },
    });

    registry.register({
      name: 'publishContent',
      description:
        'Publish approved content immediately. This posts publicly and cannot be undone from here.',
      parameters: toolSchemas.publishContent,
      permission: 'content:publish',
      requiresConfirmation: true,
      describeAction: (input) => `Publish content ${input.contentItemId} publicly, right now`,
      handler: async (input, context) => {
        const item = await prisma.contentItem.findUnique({
          where: { id: input.contentItemId },
          select: { id: true, organizationId: true, status: true, version: true, contentType: true },
        });
        if (!item || item.organizationId !== context.auth.organizationId) {
          throw new Error('That content item was not found.');
        }
        if (!canTransition(item.status, 'PUBLISHING')) {
          throw new ConflictError(
            `Content in status ${item.status} cannot be published; it must be APPROVED first.`,
          );
        }

        const capability = getCapability(item.contentType);
        const connection = await prisma.socialConnection.findFirst({
          where: {
            organizationId: context.auth.organizationId,
            provider: capability.provider ?? undefined,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (!connection) {
          throw new Error(`No active ${capability.provider} connection is available.`);
        }

        await this.queues.enqueue(
          QUEUE_NAMES.publishing,
          'publish-content',
          {
            contentItemId: item.id,
            organizationId: context.auth.organizationId,
            socialConnectionId: connection.id,
            contentVersion: item.version,
            actorUserId: context.auth.userId,
            correlationId: context.auth.requestId,
          },
          { jobId: publishJobId(item.id, item.version), attempts: 5 },
        );

        await this.audit.record({
          action: 'content.publish_requested',
          organizationId: context.auth.organizationId,
          actorUserId: context.auth.userId,
          actorType: 'AGENT',
          resourceType: 'ContentItem',
          resourceId: item.id,
          metadata: { via: 'copilot' },
        });

        return { contentItemId: item.id, status: 'QUEUED' };
      },
    });

    registry.register({
      name: 'deleteContent',
      description: 'Delete a content item that has never been published.',
      parameters: toolSchemas.deleteContent,
      permission: 'content:delete',
      requiresConfirmation: true,
      describeAction: (input) => `Permanently delete content ${input.contentItemId}`,
      handler: async (input, context) => {
        const item = await prisma.contentItem.findUnique({
          where: { id: input.contentItemId },
          select: { id: true, organizationId: true, status: true },
        });
        if (!item || item.organizationId !== context.auth.organizationId) {
          throw new Error('That content item was not found.');
        }
        if (item.status === 'PUBLISHED' || item.status === 'PUBLISHING') {
          throw new ConflictError('Published or publishing content cannot be deleted.');
        }

        await prisma.contentItem.delete({ where: { id: item.id } });
        await this.audit.record({
          action: 'content.deleted',
          organizationId: context.auth.organizationId,
          actorUserId: context.auth.userId,
          actorType: 'AGENT',
          resourceType: 'ContentItem',
          resourceId: item.id,
          metadata: { via: 'copilot' },
        });
        return { deleted: true };
      },
    });

    registry.register({
      name: 'changeAutomationMode',
      description:
        'Change the organization automation mode. AUTOPILOT allows low-risk content to publish ' +
        'without human approval.',
      parameters: toolSchemas.changeAutomationMode,
      // Deliberately the strongest permission of any tool: enabling autopilot is
      // a security-relevant configuration change, not an editing action.
      permission: 'automation:configure',
      requiresConfirmation: true,
      describeAction: (input) =>
        input.mode === 'AUTOPILOT'
          ? 'Enable AUTOPILOT, allowing low-risk approved content to publish without human review'
          : `Change the organization automation mode to ${input.mode}`,
      handler: async (input, context) => {
        const previous = await prisma.organization.findUniqueOrThrow({
          where: { id: context.auth.organizationId },
          select: { automationMode: true },
        });

        await prisma.organization.update({
          where: { id: context.auth.organizationId },
          data: {
            automationMode: input.mode,
            ...(input.mode === 'AUTOPILOT'
              ? { autopilotEnabledAt: new Date() }
              : { autopilotEnabledAt: null }),
          },
        });

        await this.audit.record({
          action:
            input.mode === 'AUTOPILOT'
              ? 'automation.autopilot_enabled'
              : previous.automationMode === 'AUTOPILOT'
                ? 'automation.autopilot_disabled'
                : 'automation.mode_changed',
          organizationId: context.auth.organizationId,
          actorUserId: context.auth.userId,
          actorType: 'AGENT',
          resourceType: 'Organization',
          resourceId: context.auth.organizationId,
          metadata: { via: 'copilot', from: previous.automationMode, to: input.mode },
        });

        return { automationMode: input.mode, previousMode: previous.automationMode };
      },
    });

    return registry;
  }
}
