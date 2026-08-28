import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@kult/auth';
import { type PrismaClient, requireInOrg, scoped } from '@kult/database';
import { ResearchSourceRegistry } from '@kult/integrations';
import { WORKFLOW_NAMES } from '@kult/ai';
import {
  ConflictError,
  NotFoundError,
  QUEUE_NAMES,
  ValidationError,
  buildPage,
  decodeCursor,
  type OpportunityStatus,
  type ResearchSourceType,
} from '@kult/shared';
import { PRISMA, RESEARCH_REGISTRY } from '../../common/tokens.js';
import { QueuesService } from '../../common/queues.service.js';

/**
 * Research, trends, niches, and opportunities.
 *
 * Running research is asynchronous by design: the API creates a
 * WorkflowExecution, enqueues a job, and returns its id. Collection and scoring
 * can take minutes across several providers, which has no business happening on
 * an HTTP request.
 */
@Injectable()
export class ResearchService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(RESEARCH_REGISTRY) private readonly sources: ResearchSourceRegistry,
    private readonly queues: QueuesService,
  ) {}

  // -- Sources --------------------------------------------------------------

  /**
   * Lists the organization's configured sources alongside every source type this
   * deployment supports, including the ones it cannot run and why.
   */
  async listSources(auth: AuthContext) {
    const [configured, availability] = await Promise.all([
      this.prisma.researchSource.findMany({
        where: scoped(auth),
        select: {
          id: true,
          type: true,
          name: true,
          config: true,
          status: true,
          unavailableReason: true,
          lastRunAt: true,
          lastItemCount: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      Promise.resolve(this.sources.availability()),
    ]);

    return {
      sources: configured,
      sourceTypes: Object.entries(availability).map(([type, state]) => ({
        type,
        available: state.available,
        ...(state.reason ? { reason: state.reason } : {}),
        ...(state.requiredVariables ? { requiredVariables: state.requiredVariables } : {}),
      })),
    };
  }

  async createSource(
    auth: AuthContext,
    input: { type: ResearchSourceType; name: string; config: Record<string, unknown> },
  ) {
    const adapter = this.sources.get(input.type);
    const availability = adapter?.availability() ?? {
      available: false,
      reason: `The ${input.type} source type is not supported by this deployment.`,
    };

    const existing = await this.prisma.researchSource.findUnique({
      where: {
        organizationId_type_name: {
          organizationId: auth.organizationId,
          type: input.type,
          name: input.name,
        },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(`A ${input.type} source named "${input.name}" already exists.`);
    }

    return this.prisma.researchSource.create({
      data: {
        organizationId: auth.organizationId,
        type: input.type,
        name: input.name,
        config: input.config as object,
        // A source whose adapter cannot run is stored, but marked so it is never
        // silently skipped and the reason stays visible in the UI.
        status: availability.available ? 'ACTIVE' : 'UNAVAILABLE',
        unavailableReason: availability.available ? null : (availability.reason ?? null),
      },
      select: { id: true, type: true, name: true, status: true, unavailableReason: true },
    });
  }

  async updateSource(
    auth: AuthContext,
    id: string,
    input: { name?: string; config?: Record<string, unknown>; enabled?: boolean },
  ) {
    const source = await this.prisma.researchSource.findUnique({
      where: { id },
      select: { id: true, organizationId: true, type: true, status: true },
    });
    requireInOrg(source, auth, 'Research source');

    return this.prisma.researchSource.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.config !== undefined ? { config: input.config as object } : {}),
        ...(input.enabled !== undefined && source!.status !== 'UNAVAILABLE'
          ? { status: input.enabled ? ('ACTIVE' as const) : ('DISABLED' as const) }
          : {}),
      },
      select: { id: true, name: true, status: true, config: true },
    });
  }

  async deleteSource(auth: AuthContext, id: string): Promise<void> {
    const source = await this.prisma.researchSource.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    requireInOrg(source, auth, 'Research source');
    await this.prisma.researchSource.delete({ where: { id } });
  }

  // -- Items ----------------------------------------------------------------

  async listItems(
    auth: AuthContext,
    query: { sourceId?: string; search?: string; cursor?: string; limit: number },
  ) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) {
      throw new ValidationError('Invalid cursor.', [{ path: 'cursor', message: 'Malformed cursor.' }]);
    }

    const rows = await this.prisma.researchItem.findMany({
      where: scoped(auth, {
        ...(query.sourceId ? { sourceId: query.sourceId } : {}),
        ...(query.search
          ? {
              OR: [
                { title: { contains: query.search, mode: 'insensitive' as const } },
                { body: { contains: query.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...(cursor
          ? {
              OR: [
                { collectedAt: { lt: cursor.createdAt } },
                { collectedAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      }),
      orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        title: true,
        url: true,
        author: true,
        publishedAt: true,
        collectedAt: true,
        sourceType: true,
        engagement: true,
        keywords: true,
        sentiment: true,
        topic: true,
      },
    });

    // collectedAt is the ordering key; map it onto the cursor's createdAt field.
    const page = buildPage(
      rows.map((row) => ({ ...row, createdAt: row.collectedAt })),
      query.limit,
    );
    return page;
  }

  /** Enqueues a research run and returns the workflow id to poll. */
  async runResearch(auth: AuthContext, input: { sourceIds?: string[] }) {
    const sources = await this.prisma.researchSource.findMany({
      where: scoped(auth, {
        status: 'ACTIVE' as const,
        ...(input.sourceIds && input.sourceIds.length > 0 ? { id: { in: input.sourceIds } } : {}),
      }),
      select: { id: true, type: true, name: true },
    });

    if (sources.length === 0) {
      throw new ValidationError('No runnable research sources.', [
        {
          path: 'sourceIds',
          message:
            'This organization has no ACTIVE research sources. Add one under Research settings, ' +
            'or check that the source you selected is not marked unavailable.',
        },
      ]);
    }

    const workflow = await this.prisma.workflow.findUnique({
      where: { name: WORKFLOW_NAMES.dailyResearch },
      select: { id: true },
    });

    const execution = await this.prisma.workflowExecution.create({
      data: {
        organizationId: auth.organizationId,
        ...(workflow ? { workflowId: workflow.id } : {}),
        workflowName: WORKFLOW_NAMES.dailyResearch,
        status: 'PENDING',
        input: { sourceIds: sources.map((source) => source.id) },
        correlationId: auth.requestId,
        triggeredById: auth.userId,
        triggeredByType: 'USER',
        steps: [],
      },
      select: { id: true },
    });

    await this.queues.enqueue(
      QUEUE_NAMES.research,
      'run-research',
      {
        organizationId: auth.organizationId,
        workflowExecutionId: execution.id,
        sourceIds: sources.map((source) => source.id),
        triggeredByUserId: auth.userId,
        correlationId: auth.requestId,
      },
      { jobId: `research:${execution.id}`, attempts: 2 },
    );

    return {
      workflowExecutionId: execution.id,
      status: 'PENDING' as const,
      sourceCount: sources.length,
    };
  }

  async getWorkflowExecution(auth: AuthContext, id: string) {
    const execution = await this.prisma.workflowExecution.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        workflowName: true,
        status: true,
        steps: true,
        currentStep: true,
        error: true,
        startedAt: true,
        finishedAt: true,
        output: true,
      },
    });
    return requireInOrg(execution, auth, 'Workflow execution');
  }

  // -- Trends ---------------------------------------------------------------

  async listTrends(auth: AuthContext, query: { limit: number; minScore?: number; status?: string }) {
    return this.prisma.trend.findMany({
      where: scoped(auth, {
        ...(query.minScore !== undefined ? { score: { gte: query.minScore } } : {}),
        ...(query.status ? { status: query.status as never } : {}),
      }),
      orderBy: [{ score: 'desc' }, { lastSeenAt: 'desc' }],
      take: query.limit,
      select: {
        id: true,
        name: true,
        slug: true,
        summary: true,
        rationale: true,
        score: true,
        components: true,
        contributions: true,
        status: true,
        keywords: true,
        firstDetectedAt: true,
        lastSeenAt: true,
        _count: { select: { signals: true } },
      },
    });
  }

  /**
   * A trend with its evidence.
   *
   * Evidence is exclusively the linked ResearchItem rows - real, retrievable
   * sources. The AI-written rationale is returned separately and is never
   * presented as evidence.
   */
  async getTrend(auth: AuthContext, id: string) {
    const trend = await this.prisma.trend.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        name: true,
        slug: true,
        summary: true,
        rationale: true,
        score: true,
        components: true,
        contributions: true,
        status: true,
        keywords: true,
        firstDetectedAt: true,
        lastSeenAt: true,
        expiresAt: true,
        signals: {
          select: {
            weight: true,
            observedAt: true,
            researchItem: {
              select: {
                id: true,
                title: true,
                url: true,
                author: true,
                publishedAt: true,
                sourceType: true,
                engagement: true,
              },
            },
          },
          orderBy: { observedAt: 'desc' },
          take: 100,
        },
      },
    });

    const found = requireInOrg(trend, auth, 'Trend');
    return {
      ...found,
      evidence: found.signals.map((signal) => ({
        ...signal.researchItem,
        weight: signal.weight,
        observedAt: signal.observedAt,
      })),
      signals: undefined,
    };
  }

  // -- Niches ---------------------------------------------------------------

  async listNiches(auth: AuthContext, query: { limit: number }) {
    return this.prisma.niche.findMany({
      where: scoped(auth),
      orderBy: { score: 'desc' },
      take: query.limit,
      select: {
        id: true,
        name: true,
        description: true,
        rationale: true,
        score: true,
        components: true,
        contributions: true,
        parentNicheId: true,
        audience: { select: { id: true, name: true } },
        createdAt: true,
      },
    });
  }

  async discoverNiches(auth: AuthContext) {
    const trendCount = await this.prisma.trend.count({ where: scoped(auth) });
    if (trendCount === 0) {
      throw new ValidationError('No trends are available to derive niches from.', [
        { path: 'trends', message: 'Run research first so trends exist to analyse.' },
      ]);
    }

    const execution = await this.prisma.workflowExecution.create({
      data: {
        organizationId: auth.organizationId,
        workflowName: WORKFLOW_NAMES.dailyResearch,
        status: 'PENDING',
        input: { onlyNiches: true },
        correlationId: auth.requestId,
        triggeredById: auth.userId,
        triggeredByType: 'USER',
        steps: [],
      },
      select: { id: true },
    });

    await this.queues.enqueue(
      QUEUE_NAMES.ai,
      'discover-niches',
      {
        organizationId: auth.organizationId,
        workflowExecutionId: execution.id,
        triggeredByUserId: auth.userId,
        correlationId: auth.requestId,
      },
      { jobId: `niches:${execution.id}` },
    );

    return { workflowExecutionId: execution.id, status: 'PENDING' as const };
  }

  // -- Opportunities --------------------------------------------------------

  async listOpportunities(
    auth: AuthContext,
    query: { status?: OpportunityStatus; limit: number; cursor?: string },
  ) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    const rows = await this.prisma.opportunity.findMany({
      where: scoped(auth, {
        ...(query.status ? { status: query.status } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      }),
      orderBy: [{ opportunityScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: opportunitySelect,
    });

    return buildPage(rows, query.limit);
  }

  async getOpportunity(auth: AuthContext, id: string) {
    const opportunity = await this.prisma.opportunity.findUnique({
      where: { id },
      select: {
        ...opportunitySelect,
        rationale: true,
        components: true,
        contributions: true,
        trends: {
          select: {
            trend: { select: { id: true, name: true, slug: true, score: true, summary: true } },
          },
        },
        niches: { select: { niche: { select: { id: true, name: true, score: true } } } },
      },
    });
    return requireInOrg(opportunity, auth, 'Opportunity');
  }

  async updateOpportunityStatus(auth: AuthContext, id: string, status: OpportunityStatus) {
    const opportunity = await this.prisma.opportunity.findUnique({
      where: { id },
      select: { id: true, organizationId: true, status: true },
    });
    requireInOrg(opportunity, auth, 'Opportunity');

    return this.prisma.opportunity.update({
      where: { id },
      data: { status },
      select: opportunitySelect,
    });
  }

  /** Enqueues opportunity generation from the current trends and niches. */
  async generateOpportunities(auth: AuthContext) {
    const execution = await this.prisma.workflowExecution.create({
      data: {
        organizationId: auth.organizationId,
        workflowName: WORKFLOW_NAMES.opportunityDiscovery,
        status: 'PENDING',
        input: {},
        correlationId: auth.requestId,
        triggeredById: auth.userId,
        triggeredByType: 'USER',
        steps: [],
      },
      select: { id: true },
    });

    await this.queues.enqueue(
      QUEUE_NAMES.ai,
      'generate-opportunities',
      {
        organizationId: auth.organizationId,
        workflowExecutionId: execution.id,
        triggeredByUserId: auth.userId,
        correlationId: auth.requestId,
      },
      { jobId: `opportunities:${execution.id}` },
    );

    return { workflowExecutionId: execution.id, status: 'PENDING' as const };
  }
}

const opportunitySelect = {
  id: true,
  organizationId: true,
  title: true,
  description: true,
  platform: true,
  contentFormat: true,
  marketingObjective: true,
  recommendedAction: true,
  relevanceScore: true,
  trendScore: true,
  competitionScore: true,
  riskScore: true,
  opportunityScore: true,
  status: true,
  expiresAt: true,
  createdAt: true,
} as const;

export { NotFoundError };
