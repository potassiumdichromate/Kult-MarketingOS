import type { Job } from 'bullmq';
import { agents } from '@kult/ai';
import { UnsupportedCapabilityError } from '@kult/shared';
import { agentContext, type WorkerContext } from '../context.js';
import { collectMetricsJob, performanceReviewJob } from '../jobs.js';
import { loadConnectionWithValidToken } from '../lib/connections.js';
import type { JobLogger } from '../logger.js';

/**
 * Metric collection and performance analysis.
 *
 * The governing rule: a metric a provider does not return is stored as null,
 * never as zero. LinkedIn, for example, exposes no per-post engagement without
 * the approval-gated r_member_social permission - so LinkedIn publications
 * simply have no snapshots, and the analytics layer reports that as a gap rather
 * than as zero engagement.
 */

export async function processCollectMetrics(
  context: WorkerContext,
  job: Job,
  log: JobLogger,
): Promise<{ collected: boolean; reason?: string }> {
  const payload = collectMetricsJob.parse(job.data);

  const publication = await context.prisma.publication.findUnique({
    where: { id: payload.publicationId },
    select: {
      id: true,
      organizationId: true,
      provider: true,
      providerPostId: true,
      status: true,
      socialConnectionId: true,
    },
  });

  if (!publication || publication.organizationId !== payload.organizationId) {
    return { collected: false, reason: 'Publication not found.' };
  }
  if (publication.status !== 'SUCCEEDED' || !publication.providerPostId) {
    return { collected: false, reason: 'Publication did not complete, so it has no metrics.' };
  }

  const connection = await loadConnectionWithValidToken(context, publication.socialConnectionId);

  // Ask the connection what it can do before calling; a connection that cannot
  // read metrics should not generate a failed provider request every sweep.
  const capabilities = connection.capabilities as { canReadMetrics?: boolean };
  if (capabilities.canReadMetrics === false) {
    return {
      collected: false,
      reason: `${publication.provider} does not expose post metrics to this connection.`,
    };
  }

  try {
    const adapter = context.social.getConfigured(publication.provider);
    const metrics = await adapter.getMetrics({
      tokens: connection.tokens,
      account: {
        providerAccountId: connection.providerAccountId,
        accountName: connection.accountName,
        ...(connection.accountUsername ? { accountUsername: connection.accountUsername } : {}),
        metadata: connection.metadata,
      },
      providerPostId: publication.providerPostId,
    });

    // Engagement rate is only meaningful when impressions were actually reported.
    const engagements =
      (metrics.likes ?? 0) + (metrics.comments ?? 0) + (metrics.shares ?? 0) + (metrics.reposts ?? 0);
    const engagementRate =
      metrics.impressions && metrics.impressions > 0
        ? (engagements / metrics.impressions) * 100
        : null;

    await context.prisma.postMetricSnapshot.create({
      data: {
        organizationId: publication.organizationId,
        publicationId: publication.id,
        provider: publication.provider,
        capturedAt: metrics.capturedAt,
        impressions: metrics.impressions ?? null,
        likes: metrics.likes ?? null,
        comments: metrics.comments ?? null,
        shares: metrics.shares ?? null,
        reposts: metrics.reposts ?? null,
        saves: metrics.saves ?? null,
        clicks: metrics.clicks ?? null,
        videoViews: metrics.videoViews ?? null,
        engagementRate,
        raw: metrics.raw as object,
      },
    });

    log.info({ publicationId: publication.id, provider: publication.provider }, 'Collected metrics');
    return { collected: true };
  } catch (error) {
    // A provider that structurally cannot supply metrics is not a job failure.
    // Record why on the connection and stop asking.
    if (error instanceof UnsupportedCapabilityError) {
      await context.prisma.socialConnection.update({
        where: { id: connection.id },
        data: {
          capabilities: {
            ...(connection.capabilities as object),
            canReadMetrics: false,
            unavailable: {
              ...((connection.capabilities as { unavailable?: Record<string, string> }).unavailable ??
                {}),
              metrics: error.requirement,
            },
          } as object,
        },
      });
      log.info(
        { publicationId: publication.id, provider: publication.provider },
        'Provider does not support post metrics for this connection',
      );
      return { collected: false, reason: error.requirement };
    }
    throw error;
  }
}

/**
 * Sweeps recent publications for fresh metrics.
 *
 * Engagement on a post keeps moving for days, so a single reading after
 * publication would understate it. This re-reads posts from the last two weeks
 * and skips any already sampled in the past six hours.
 */
export async function processSweepMetrics(
  context: WorkerContext,
  _job: Job,
  log: JobLogger,
): Promise<{ enqueued: number }> {
  const since = new Date(Date.now() - 14 * 86_400_000);
  const recentlySampled = new Date(Date.now() - 6 * 3_600_000);

  const publications = await context.prisma.publication.findMany({
    where: {
      status: 'SUCCEEDED',
      publishedAt: { gte: since },
      metrics: { none: { capturedAt: { gte: recentlySampled } } },
    },
    select: { id: true, organizationId: true },
    take: 500,
  });

  for (const publication of publications) {
    await context.queues.analytics.add(
      'collect-metrics',
      {
        organizationId: publication.organizationId,
        publicationId: publication.id,
        correlationId: `sweep:${Date.now()}`,
      },
      {
        // Deterministic per six-hour window, so overlapping sweeps collapse.
        jobId: `metrics:${publication.id}:${Math.floor(Date.now() / (6 * 3_600_000))}`,
        attempts: 2,
      },
    );
  }

  log.info({ enqueued: publications.length }, 'Enqueued metric collection');
  return { enqueued: publications.length };
}

/**
 * Performance review: analyse, then propose strategy insights.
 *
 * Insights are always PROPOSED. Nothing here modifies brand policy or strategy;
 * a human accepts or rejects each proposal.
 */
export async function processPerformanceReview(
  context: WorkerContext,
  job: Job,
  log: JobLogger,
): Promise<{ insights: number }> {
  const payload = performanceReviewJob.parse(job.data);
  const since = new Date(Date.now() - payload.periodDays * 86_400_000);

  await context.prisma.workflowExecution.update({
    where: { id: payload.workflowExecutionId },
    data: { status: 'RUNNING', currentStep: 'analyze-performance' },
  });

  try {
    const [organization, publications, connections] = await Promise.all([
      context.prisma.organization.findUniqueOrThrow({
        where: { id: payload.organizationId },
        select: { timezone: true },
      }),
      context.prisma.publication.findMany({
        where: {
          organizationId: payload.organizationId,
          status: 'SUCCEEDED',
          publishedAt: { gte: since },
        },
        select: {
          id: true,
          provider: true,
          publishedAt: true,
          contentItem: {
            select: { id: true, contentType: true, body: true, cta: true, hashtags: true },
          },
          metrics: {
            orderBy: { capturedAt: 'desc' },
            take: 1,
            select: {
              impressions: true,
              likes: true,
              comments: true,
              shares: true,
              reposts: true,
              saves: true,
              clicks: true,
              videoViews: true,
              engagementRate: true,
            },
          },
        },
        take: 300,
      }),
      context.prisma.socialConnection.findMany({
        where: { organizationId: payload.organizationId },
        select: { provider: true, capabilities: true },
      }),
    ]);

    // Tell the agent explicitly where data is missing, so it reports a gap
    // instead of inferring numbers that were never measured.
    const metricGaps = connections
      .filter(
        (connection) =>
          (connection.capabilities as { canReadMetrics?: boolean }).canReadMetrics === false,
      )
      .map((connection) => ({
        platform: connection.provider,
        reason:
          (connection.capabilities as { unavailable?: Record<string, string> }).unavailable
            ?.metrics ?? `${connection.provider} does not expose post metrics.`,
      }));

    const posts = publications
      .filter((publication) => publication.metrics.length > 0 && publication.publishedAt)
      .map((publication) => {
        const snapshot = publication.metrics[0]!;
        return {
          contentItemId: publication.contentItem.id,
          platform: publication.provider,
          contentType: publication.contentItem.contentType,
          // The opening line is the hook, which is what the analysis compares.
          hook: publication.contentItem.body.split('\n')[0]?.slice(0, 200) ?? '',
          publishedAt: publication.publishedAt!,
          publishedHourLocal: localHour(publication.publishedAt!, organization.timezone),
          topics: publication.contentItem.hashtags,
          cta: publication.contentItem.cta,
          metrics: {
            impressions: snapshot.impressions,
            likes: snapshot.likes,
            comments: snapshot.comments,
            shares: snapshot.shares,
            reposts: snapshot.reposts,
            saves: snapshot.saves,
            clicks: snapshot.clicks,
            videoViews: snapshot.videoViews,
            engagementRate: snapshot.engagementRate,
          },
        };
      });

    const { output: analysis } = await context.agents.run(
      agents.AnalyticsAgent,
      agentContext(context, payload),
      { periodDays: payload.periodDays, posts, metricGaps, baselines: {} },
    );

    const accepted = await context.prisma.strategyInsight.findMany({
      where: { organizationId: payload.organizationId, status: 'ACCEPTED' },
      select: { recommendation: true },
      take: 50,
    });

    const { output: proposals } = await context.agents.run(
      agents.OptimizationAgent,
      agentContext(context, payload),
      {
        analysis,
        existingAcceptedInsights: accepted.map((insight) => insight.recommendation),
        minimumSampleSize: 5,
      },
    );

    for (const insight of proposals.insights) {
      await context.prisma.strategyInsight.create({
        data: {
          organizationId: payload.organizationId,
          type: insight.type.slice(0, 120),
          evidence: { summary: insight.evidenceSummary } as object,
          confidence: insight.confidence,
          recommendation: insight.recommendation,
          supportingContentIds: insight.supportingContentIds,
          status: 'PROPOSED',
        },
      });
    }

    await context.prisma.workflowExecution.update({
      where: { id: payload.workflowExecutionId },
      data: {
        status: 'SUCCEEDED',
        currentStep: null,
        finishedAt: new Date(),
        output: {
          postsAnalyzed: posts.length,
          insightsProposed: proposals.insights.length,
          summary: analysis.summary,
        } as object,
      },
    });

    log.info(
      { postsAnalyzed: posts.length, insights: proposals.insights.length },
      'Performance review complete',
    );

    return { insights: proposals.insights.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.prisma.workflowExecution.update({
      where: { id: payload.workflowExecutionId },
      data: { status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 2_000) },
    });
    throw error;
  }
}

/**
 * The hour of day in the organization's own timezone.
 * Posting-window analysis is meaningless in UTC when the audience is not.
 */
function localHour(date: Date, timeZone: string): number {
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    }).format(date);
    const hour = Number.parseInt(formatted, 10);
    return Number.isFinite(hour) ? hour % 24 : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}
