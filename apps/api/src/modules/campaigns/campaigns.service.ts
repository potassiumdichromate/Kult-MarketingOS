import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@kult/auth';
import { type PrismaClient, requireInOrg, scoped } from '@kult/database';
import { WORKFLOW_NAMES } from '@kult/ai';
import {
  ConflictError,
  QUEUE_NAMES,
  ValidationError,
  type CampaignStatus,
  type CampaignTemplate,
  type SocialProvider,
} from '@kult/shared';
import { PRISMA } from '../../common/tokens.js';
import { QueuesService } from '../../common/queues.service.js';

/**
 * Campaign management.
 *
 * Plan generation is asynchronous: producing a strategy and a 30-day calendar is
 * a multi-minute reasoning task, so the API creates the campaign, enqueues the
 * generation, and lets the client poll.
 *
 * Activation is the point at which a campaign's scheduled content becomes live
 * work, so it is guarded: a campaign with no content cannot be activated, and
 * activation is audited.
 */
@Injectable()
export class CampaignsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly queues: QueuesService,
  ) {}

  async list(auth: AuthContext, query: { status?: CampaignStatus; limit: number }) {
    return this.prisma.campaign.findMany({
      where: scoped(auth, { ...(query.status ? { status: query.status } : {}) }),
      orderBy: { startDate: 'desc' },
      take: query.limit,
      select: campaignListSelect,
    });
  }

  async get(auth: AuthContext, id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      select: {
        ...campaignListSelect,
        strategy: true,
        approvalMode: true,
        audience: { select: { id: true, name: true } },
        createdBy: { select: { id: true, displayName: true, email: true } },
        steps: {
          select: {
            id: true,
            order: true,
            title: true,
            description: true,
            dueAt: true,
            completedAt: true,
          },
          orderBy: { order: 'asc' },
        },
        contentItems: {
          select: {
            id: true,
            contentType: true,
            title: true,
            status: true,
            scheduledAt: true,
            publishedAt: true,
          },
          orderBy: { scheduledAt: 'asc' },
        },
      },
    });
    return requireInOrg(campaign, auth, 'Campaign');
  }

  async create(
    auth: AuthContext,
    input: {
      name: string;
      objective: string;
      template?: CampaignTemplate;
      audienceId?: string;
      startDate: Date;
      endDate: Date;
      platforms: SocialProvider[];
      budgetAmount?: number;
      budgetCurrency?: string;
    },
  ) {
    if (input.endDate <= input.startDate) {
      throw new ValidationError('The campaign end date must be after its start date.', [
        { path: 'endDate', message: 'Must be later than startDate.' },
      ]);
    }

    if (input.audienceId) {
      const audience = await this.prisma.audience.findUnique({
        where: { id: input.audienceId },
        select: { organizationId: true },
      });
      requireInOrg(audience, auth, 'Audience');
    }

    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: auth.organizationId },
      select: { automationMode: true },
    });

    return this.prisma.campaign.create({
      data: {
        organizationId: auth.organizationId,
        name: input.name,
        objective: input.objective,
        template: input.template ?? null,
        audienceId: input.audienceId ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
        platforms: input.platforms,
        budgetAmount: input.budgetAmount ?? null,
        budgetCurrency: input.budgetCurrency ?? null,
        status: 'DRAFT',
        // A campaign inherits the organization's automation posture at creation,
        // and can then be tightened per campaign.
        approvalMode: organization.automationMode,
        createdById: auth.userId,
      },
      select: campaignListSelect,
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    input: {
      name?: string;
      objective?: string;
      startDate?: Date;
      endDate?: Date;
      platforms?: SocialProvider[];
      approvalMode?: 'MANUAL' | 'COPILOT' | 'AUTOPILOT';
      strategy?: Record<string, unknown>;
    },
  ) {
    const existing = await this.get(auth, id);
    if (existing.status === 'COMPLETED' || existing.status === 'ARCHIVED') {
      throw new ConflictError(`A ${existing.status} campaign cannot be edited.`);
    }

    const startDate = input.startDate ?? existing.startDate;
    const endDate = input.endDate ?? existing.endDate;
    if (endDate <= startDate) {
      throw new ValidationError('The campaign end date must be after its start date.', [
        { path: 'endDate', message: 'Must be later than startDate.' },
      ]);
    }

    return this.prisma.campaign.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.objective !== undefined ? { objective: input.objective } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
        ...(input.platforms !== undefined ? { platforms: input.platforms } : {}),
        ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode } : {}),
        ...(input.strategy !== undefined ? { strategy: input.strategy as object } : {}),
      },
      select: campaignListSelect,
    });
  }

  /** Enqueues plan generation. The worker writes the strategy and calendar drafts. */
  async generatePlan(
    auth: AuthContext,
    id: string,
    input: { postsPerWeek?: number; opportunityIds?: string[] },
  ) {
    const campaign = await this.get(auth, id);
    if (campaign.status !== 'DRAFT') {
      throw new ConflictError('Only a DRAFT campaign can have its plan generated.');
    }

    const execution = await this.prisma.workflowExecution.create({
      data: {
        organizationId: auth.organizationId,
        workflowName: WORKFLOW_NAMES.campaignGeneration,
        status: 'PENDING',
        input: { campaignId: id, ...input },
        correlationId: auth.requestId,
        triggeredById: auth.userId,
        triggeredByType: 'USER',
        steps: [],
      },
      select: { id: true },
    });

    await this.queues.enqueue(
      QUEUE_NAMES.ai,
      'generate-campaign',
      {
        organizationId: auth.organizationId,
        campaignId: id,
        workflowExecutionId: execution.id,
        postsPerWeek: input.postsPerWeek ?? 5,
        opportunityIds: input.opportunityIds ?? [],
        triggeredByUserId: auth.userId,
        correlationId: auth.requestId,
      },
      { jobId: `campaign:${execution.id}` },
    );

    return { workflowExecutionId: execution.id, status: 'PENDING' as const };
  }

  async activate(auth: AuthContext, id: string) {
    const campaign = await this.get(auth, id);
    if (campaign.status === 'ACTIVE') {
      throw new ConflictError('This campaign is already active.');
    }
    if (campaign.status === 'COMPLETED' || campaign.status === 'ARCHIVED') {
      throw new ConflictError(`A ${campaign.status} campaign cannot be activated.`);
    }
    if (campaign.contentItems.length === 0) {
      throw new ValidationError('This campaign has no content.', [
        {
          path: 'contentItems',
          message: 'Generate or add content before activating the campaign.',
        },
      ]);
    }

    return this.prisma.campaign.update({
      where: { id },
      data: { status: 'ACTIVE', activatedAt: new Date() },
      select: campaignListSelect,
    });
  }

  async pause(auth: AuthContext, id: string) {
    const campaign = await this.get(auth, id);
    if (campaign.status !== 'ACTIVE') {
      throw new ConflictError('Only an ACTIVE campaign can be paused.');
    }
    return this.prisma.campaign.update({
      where: { id },
      data: { status: 'PAUSED' },
      select: campaignListSelect,
    });
  }
}

const campaignListSelect = {
  id: true,
  organizationId: true,
  name: true,
  objective: true,
  template: true,
  startDate: true,
  endDate: true,
  platforms: true,
  budgetAmount: true,
  budgetCurrency: true,
  status: true,
  activatedAt: true,
  completedAt: true,
  createdAt: true,
  _count: { select: { contentItems: true } },
} as const;
