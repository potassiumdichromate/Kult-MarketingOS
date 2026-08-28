import type { Job } from 'bullmq';
import { agents } from '@kult/ai';
import { getCapability, type ContentType, type SocialProvider } from '@kult/shared';
import { agentContext, type WorkerContext } from '../context.js';
import {
  discoverNichesJob,
  generateCampaignJob,
  generateContentJob,
  generateOpportunitiesJob,
} from '../jobs.js';
import { audit, notify } from '../lib/notify.js';
import type { JobLogger } from '../logger.js';

/**
 * AI generation jobs.
 *
 * Every one of these runs through AgentRunner, which writes an AgentExecution
 * row before the agent starts and settles it afterwards. That is what makes each
 * AI decision traceable to an organization, a trigger, a model, a token count,
 * and a latency.
 */

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export async function processGenerateOpportunities(
  context: WorkerContext,
  job: Job,
  log: JobLogger,
): Promise<{ created: number }> {
  const payload = generateOpportunitiesJob.parse(job.data);

  const created = await runWorkflowStep(
    context,
    payload.workflowExecutionId,
    'generate-opportunities',
    async () => {
      const [trends, niches] = await Promise.all([
        context.prisma.trend.findMany({
          where: {
            organizationId: payload.organizationId,
            status: { in: ['EMERGING', 'ACTIVE'] },
          },
          orderBy: { score: 'desc' },
          take: 15,
          select: { slug: true, name: true, summary: true, score: true, id: true },
        }),
        context.prisma.niche.findMany({
          where: { organizationId: payload.organizationId },
          orderBy: { score: 'desc' },
          take: 10,
          select: { id: true, name: true, description: true, score: true },
        }),
      ]);

      if (trends.length === 0) {
        log.info('No trends available; nothing to turn into opportunities');
        return 0;
      }

      const historicalFit = await buildHistoricalFit(context, payload.organizationId);

      const { output } = await context.agents.run(
        agents.OpportunityAgent,
        agentContext(context, payload),
        {
          trends: trends.map((trend) => ({
            slug: trend.slug,
            name: trend.name,
            summary: trend.summary,
            score: trend.score,
            riskLevel: 'LOW',
          })),
          niches: niches.map((niche) => ({
            name: niche.name,
            description: niche.description,
            score: niche.score,
          })),
          historicalFit,
          maxOpportunities: 7,
        },
      );

      const trendIdBySlug = new Map(trends.map((trend) => [trend.slug, trend.id]));
      const nicheIdByName = new Map(niches.map((niche) => [niche.name, niche.id]));

      let persisted = 0;

      for (const draft of output.opportunities) {
        const opportunity = await context.prisma.opportunity.create({
          data: {
            organizationId: payload.organizationId,
            title: draft.title.slice(0, 300),
            description: draft.description,
            rationale: draft.rationale,
            platform: (draft.platform ?? null) as SocialProvider | null,
            contentFormat: (draft.contentFormat ?? null) as ContentType | null,
            marketingObjective: (draft.marketingObjective ?? null) as never,
            recommendedAction: draft.recommendedAction,
            relevanceScore: draft.relevanceScore,
            trendScore: draft.trendScore,
            competitionScore: draft.competitionScore,
            riskScore: draft.riskScore,
            opportunityScore: draft.opportunityScore,
            components: draft.components as object,
            contributions: draft.contributions as object,
            status: 'NEW',
            expiresAt: draft.expiresInHours
              ? new Date(Date.now() + draft.expiresInHours * 3_600_000)
              : null,
          },
          select: { id: true },
        });

        // Provenance links, so an opportunity can always be traced to evidence.
        for (const slug of draft.sourceTrendSlugs) {
          const trendId = trendIdBySlug.get(slug);
          if (!trendId) continue;
          await context.prisma.opportunityTrend
            .create({ data: { opportunityId: opportunity.id, trendId } })
            .catch(() => undefined);
        }
        for (const name of draft.sourceNicheNames) {
          const nicheId = nicheIdByName.get(name);
          if (!nicheId) continue;
          await context.prisma.opportunityNiche
            .create({ data: { opportunityId: opportunity.id, nicheId } })
            .catch(() => undefined);
        }

        persisted += 1;
      }

      return persisted;
    },
  );

  if (created > 0) {
    await notify(context, {
      organizationId: payload.organizationId,
      ...(payload.triggeredByUserId ? { userId: payload.triggeredByUserId } : {}),
      type: 'OPPORTUNITY_DISCOVERED',
      title: `${created} new marketing ${created === 1 ? 'opportunity' : 'opportunities'}`,
      resourceType: 'WorkflowExecution',
      resourceId: payload.workflowExecutionId,
    });
  }

  return { created };
}

/**
 * Historical fit per platform/format, from measured engagement.
 *
 * Pairings with no measured history are simply absent, and the agent's scoring
 * falls back to a neutral 50 rather than inventing a preference.
 */
async function buildHistoricalFit(
  context: WorkerContext,
  organizationId: string,
): Promise<Record<string, number>> {
  const publications = await context.prisma.publication.findMany({
    where: { organizationId, status: 'SUCCEEDED' },
    select: {
      provider: true,
      contentItem: { select: { contentType: true } },
      metrics: {
        orderBy: { capturedAt: 'desc' },
        take: 1,
        select: { impressions: true, likes: true, comments: true, shares: true },
      },
    },
    take: 200,
  });

  const buckets = new Map<string, { total: number; count: number }>();

  for (const publication of publications) {
    const snapshot = publication.metrics[0];
    if (!snapshot) continue;

    const engagement =
      (snapshot.likes ?? 0) + (snapshot.comments ?? 0) + (snapshot.shares ?? 0);
    const impressions = snapshot.impressions ?? 0;
    if (impressions === 0 && engagement === 0) continue;

    const key = `${publication.provider}:${publication.contentItem.contentType}`;
    const bucket = buckets.get(key) ?? { total: 0, count: 0 };
    // Engagement rate where impressions exist, raw engagement otherwise.
    bucket.total += impressions > 0 ? (engagement / impressions) * 100 : engagement;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  const result: Record<string, number> = {};
  const averages = [...buckets.entries()].map(([key, bucket]) => ({
    key,
    average: bucket.total / bucket.count,
  }));
  const best = Math.max(...averages.map((entry) => entry.average), 0);

  for (const entry of averages) {
    // Normalise onto 0-100 relative to the best performing pairing.
    result[entry.key] = best > 0 ? Math.round((entry.average / best) * 100) : 50;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Niches (standalone trigger)
// ---------------------------------------------------------------------------

export async function processDiscoverNiches(
  context: WorkerContext,
  job: Job,
  _log: JobLogger,
): Promise<{ created: number }> {
  const payload = discoverNichesJob.parse(job.data);

  const created = await runWorkflowStep(
    context,
    payload.workflowExecutionId,
    'discover-niches',
    async () => {
      const trends = await context.prisma.trend.findMany({
        where: { organizationId: payload.organizationId },
        orderBy: { score: 'desc' },
        take: 15,
        select: { name: true, summary: true, keywords: true },
      });
      if (trends.length === 0) return 0;

      const { output } = await context.agents.run(
        agents.NicheDiscoveryAgent,
        agentContext(context, payload),
        { trends, maxNiches: 6 },
      );

      for (const niche of output.niches) {
        await context.prisma.niche.upsert({
          where: {
            organizationId_name: { organizationId: payload.organizationId, name: niche.name },
          },
          create: {
            organizationId: payload.organizationId,
            name: niche.name,
            description: niche.description,
            rationale: niche.rationale,
            score: niche.score,
            components: niche.components as object,
            contributions: niche.contributions as object,
          },
          update: {
            description: niche.description,
            rationale: niche.rationale,
            score: niche.score,
            components: niche.components as object,
            contributions: niche.contributions as object,
          },
        });
      }

      return output.niches.length;
    },
  );

  return { created };
}

// ---------------------------------------------------------------------------
// Campaign generation
// ---------------------------------------------------------------------------

export async function processGenerateCampaign(
  context: WorkerContext,
  job: Job,
  log: JobLogger,
): Promise<{ calendarEntries: number; draftsCreated: number }> {
  const payload = generateCampaignJob.parse(job.data);

  const campaign = await context.prisma.campaign.findUnique({
    where: { id: payload.campaignId },
    select: {
      id: true,
      organizationId: true,
      name: true,
      objective: true,
      template: true,
      startDate: true,
      endDate: true,
      platforms: true,
      audience: { select: { name: true } },
    },
  });

  if (!campaign || campaign.organizationId !== payload.organizationId) {
    throw new Error(`Campaign ${payload.campaignId} was not found for this organization.`);
  }

  const opportunities = payload.opportunityIds.length
    ? await context.prisma.opportunity.findMany({
        where: {
          organizationId: payload.organizationId,
          id: { in: payload.opportunityIds },
        },
        select: { title: true, description: true },
      })
    : [];

  const durationDays = Math.max(
    1,
    Math.ceil((campaign.endDate.getTime() - campaign.startDate.getTime()) / 86_400_000),
  );

  const result = await runWorkflowStep(
    context,
    payload.workflowExecutionId,
    'generate-plan',
    async () => {
      const { output } = await context.agents.run(
        agents.CampaignAgent,
        agentContext(context, payload),
        {
          goal: campaign.objective,
          template: campaign.template,
          durationDays,
          platforms: campaign.platforms,
          audienceName: campaign.audience?.name ?? null,
          opportunities,
          postsPerWeek: payload.postsPerWeek,
        },
      );

      await context.prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          strategy: {
            summary: output.strategySummary,
            audience: output.audience,
            contentPillars: output.contentPillars,
            platformAllocation: output.platformAllocation,
            successMetrics: output.successMetrics,
            risks: output.risks,
          } as object,
        },
      });

      // Calendar entries become real, editable drafts rather than a static plan.
      let draftsCreated = 0;
      for (const [index, entry] of output.calendar.entries()) {
        const capability = getCapability(entry.contentFormat);
        const scheduledAt = new Date(
          campaign.startDate.getTime() + entry.dayOffset * 86_400_000,
        );

        await context.prisma.contentItem.create({
          data: {
            organizationId: payload.organizationId,
            campaignId: campaign.id,
            contentType: entry.contentFormat,
            platform: capability.provider,
            title: entry.concept.slice(0, 300),
            // The concept and hook are the brief; copy is generated on demand so
            // a 30-day campaign does not spend 30 model calls before review.
            body: `${entry.hook}\n\n${entry.concept}`,
            status: 'DRAFT',
            requiresApproval: true,
            scheduledAt,
            createdByAgent: 'CampaignAgent',
            ...(payload.triggeredByUserId ? { createdById: payload.triggeredByUserId } : {}),
          },
        });

        await context.prisma.campaignStep.create({
          data: {
            campaignId: campaign.id,
            order: index,
            title: entry.concept.slice(0, 300),
            description: `${entry.contentPillar} - ${entry.objective}`,
            dueAt: scheduledAt,
          },
        }).catch(() => undefined);

        draftsCreated += 1;
      }

      return { calendarEntries: output.calendar.length, draftsCreated };
    },
  );

  log.info(
    { campaignId: campaign.id, drafts: result.draftsCreated },
    'Generated campaign plan and drafts',
  );

  await audit(context, {
    action: 'campaign.created',
    organizationId: payload.organizationId,
    actorUserId: payload.triggeredByUserId ?? null,
    actorType: 'AGENT',
    resourceType: 'Campaign',
    resourceId: campaign.id,
    metadata: { generated: true, drafts: result.draftsCreated },
  });

  return result;
}

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

export async function processGenerateContent(
  context: WorkerContext,
  job: Job,
  log: JobLogger,
): Promise<{ contentItemId: string; requiresApproval: boolean }> {
  const payload = generateContentJob.parse(job.data);

  const content = await context.prisma.contentItem.findUnique({
    where: { id: payload.contentItemId },
    select: { id: true, organizationId: true, contentType: true, status: true, version: true },
  });

  if (!content || content.organizationId !== payload.organizationId) {
    throw new Error(`Content item ${payload.contentItemId} was not found for this organization.`);
  }
  if (content.status === 'PUBLISHED' || content.status === 'PUBLISHING') {
    return { contentItemId: content.id, requiresApproval: false };
  }

  const organization = await context.prisma.organization.findUniqueOrThrow({
    where: { id: payload.organizationId },
    select: { automationMode: true },
  });

  const { output, executionId } = await context.agents.run(
    agents.ContentCreationAgent,
    agentContext(context, payload),
    {
      contentType: content.contentType,
      brief: payload.brief,
      organizationRequiresApprovalAlways: organization.automationMode === 'MANUAL',
    },
  );

  const nextVersion = content.version + 1;

  await context.prisma.$transaction([
    context.prisma.contentItem.update({
      where: { id: content.id },
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
        createdByAgent: 'ContentCreationAgent',
        createdByExecutionId: executionId,
      },
    }),
    context.prisma.contentVersion.create({
      data: {
        contentItemId: content.id,
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
    }),
  ]);

  log.info(
    {
      contentItemId: content.id,
      riskLevel: output.riskLevel,
      requiresApproval: output.requiresApproval,
      unverifiedClaims: output.verifiedClaims.filter((claim) => !claim.verified).length,
    },
    'Generated content draft',
  );

  if (output.requiresApproval) {
    await notify(context, {
      organizationId: payload.organizationId,
      type: 'APPROVAL_REQUIRED',
      severity: output.riskLevel === 'LOW' ? 'INFO' : 'WARNING',
      title: 'Generated content needs review',
      body:
        output.approvalReasons.length > 0
          ? output.approvalReasons.join(' ')
          : 'Review before publishing.',
      resourceType: 'ContentItem',
      resourceId: content.id,
    });
  }

  return { contentItemId: content.id, requiresApproval: output.requiresApproval };
}

/**
 * Runs one step against an existing WorkflowExecution.
 *
 * The API creates the execution row up front so it can return an id
 * immediately; this marks it RUNNING, then settles it either way, so a caller
 * polling the workflow always sees a truthful terminal state.
 */
async function runWorkflowStep<T>(
  context: WorkerContext,
  workflowExecutionId: string,
  stepName: string,
  operation: () => Promise<T>,
): Promise<T> {
  await context.prisma.workflowExecution.update({
    where: { id: workflowExecutionId },
    data: {
      status: 'RUNNING',
      currentStep: stepName,
      steps: [{ name: stepName, status: 'RUNNING', startedAt: new Date().toISOString() }] as object,
    },
  });

  try {
    const result = await operation();

    await context.prisma.workflowExecution.update({
      where: { id: workflowExecutionId },
      data: {
        status: 'SUCCEEDED',
        currentStep: null,
        finishedAt: new Date(),
        output: (typeof result === 'object' && result !== null
          ? result
          : { result }) as object,
        steps: [
          { name: stepName, status: 'SUCCEEDED', finishedAt: new Date().toISOString() },
        ] as object,
      },
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await context.prisma.workflowExecution.update({
      where: { id: workflowExecutionId },
      data: {
        status: 'FAILED',
        currentStep: stepName,
        finishedAt: new Date(),
        error: message.slice(0, 2_000),
        steps: [
          {
            name: stepName,
            status: 'FAILED',
            finishedAt: new Date().toISOString(),
            error: message.slice(0, 1_000),
          },
        ] as object,
      },
    });

    throw error;
  }
}
