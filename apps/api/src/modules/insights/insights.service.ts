import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@kult/auth';
import { type PrismaClient, requireInOrg, scoped } from '@kult/database';
import { WORKFLOW_NAMES } from '@kult/ai';
import { QUEUE_NAMES, type OpportunityStatus, type SocialProvider } from '@kult/shared';
import type { TrendStatus } from '@kult/database';
import { PRISMA } from '../../common/tokens.js';
import { QueuesService } from '../../common/queues.service.js';

/**
 * Analytics, agent activity, notifications, and the dashboard.
 *
 * Every figure returned here is derived from stored metric snapshots. Where a
 * provider does not expose a metric, the aggregate reports it as null and the
 * response carries an explicit `gaps` list naming the platform and the reason -
 * so the UI can say "LinkedIn engagement is unavailable because r_member_social
 * was not granted" rather than rendering a zero.
 */
@Injectable()
export class InsightsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly queues: QueuesService,
  ) {}

  // -- Analytics ------------------------------------------------------------

  async overview(auth: AuthContext, periodDays: number) {
    const since = new Date(Date.now() - periodDays * 86_400_000);

    const [publications, latestSnapshots, connections, contentCounts] = await Promise.all([
      this.prisma.publication.findMany({
        where: scoped(auth, { status: 'SUCCEEDED' as const, publishedAt: { gte: since } }),
        select: {
          id: true,
          provider: true,
          publishedAt: true,
          contentItem: { select: { id: true, contentType: true, title: true } },
        },
      }),
      this.prisma.postMetricSnapshot.findMany({
        where: scoped(auth, { capturedAt: { gte: since } }),
        orderBy: { capturedAt: 'desc' },
        select: {
          publicationId: true,
          provider: true,
          impressions: true,
          likes: true,
          comments: true,
          shares: true,
          reposts: true,
          saves: true,
          clicks: true,
          videoViews: true,
          engagementRate: true,
          capturedAt: true,
        },
      }),
      this.prisma.socialConnection.findMany({
        where: scoped(auth),
        select: { provider: true, status: true, capabilities: true, accountName: true },
      }),
      this.prisma.contentItem.groupBy({
        by: ['status'],
        where: scoped(auth),
        _count: { _all: true },
      }),
    ]);

    // Keep only the most recent snapshot per publication.
    const latestByPublication = new Map<string, (typeof latestSnapshots)[number]>();
    for (const snapshot of latestSnapshots) {
      if (!latestByPublication.has(snapshot.publicationId)) {
        latestByPublication.set(snapshot.publicationId, snapshot);
      }
    }

    const totals = {
      posts: publications.length,
      impressions: sumNullable([...latestByPublication.values()].map((s) => s.impressions)),
      likes: sumNullable([...latestByPublication.values()].map((s) => s.likes)),
      comments: sumNullable([...latestByPublication.values()].map((s) => s.comments)),
      shares: sumNullable([...latestByPublication.values()].map((s) => s.shares)),
      reposts: sumNullable([...latestByPublication.values()].map((s) => s.reposts)),
      saves: sumNullable([...latestByPublication.values()].map((s) => s.saves)),
      clicks: sumNullable([...latestByPublication.values()].map((s) => s.clicks)),
      videoViews: sumNullable([...latestByPublication.values()].map((s) => s.videoViews)),
    };

    // Report, per provider, why metrics may be missing.
    const gaps: Array<{ provider: SocialProvider; reason: string }> = [];
    for (const connection of connections) {
      const capabilities = connection.capabilities as
        | { canReadMetrics?: boolean; unavailable?: Record<string, string> }
        | null;
      if (capabilities && capabilities.canReadMetrics === false) {
        gaps.push({
          provider: connection.provider,
          reason:
            capabilities.unavailable?.metrics ??
            `${connection.provider} does not expose post metrics to this connection.`,
        });
      }
    }

    const byProvider = new Map<string, { provider: string; posts: number; impressions: number | null }>();
    for (const publication of publications) {
      const entry = byProvider.get(publication.provider) ?? {
        provider: publication.provider,
        posts: 0,
        impressions: null,
      };
      entry.posts += 1;
      const snapshot = latestByPublication.get(publication.id);
      if (snapshot?.impressions != null) {
        entry.impressions = (entry.impressions ?? 0) + snapshot.impressions;
      }
      byProvider.set(publication.provider, entry);
    }

    return {
      periodDays,
      since,
      totals,
      byProvider: [...byProvider.values()],
      contentByStatus: Object.fromEntries(
        contentCounts.map((row) => [row.status, row._count._all]),
      ),
      metricGaps: gaps,
      measuredPosts: latestByPublication.size,
    };
  }

  async postAnalytics(auth: AuthContext, limit: number) {
    const publications = await this.prisma.publication.findMany({
      where: scoped(auth, { status: 'SUCCEEDED' as const }),
      orderBy: { publishedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        provider: true,
        providerPostId: true,
        providerUrl: true,
        publishedAt: true,
        contentItem: {
          select: { id: true, title: true, contentType: true, body: true, hashtags: true },
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
            capturedAt: true,
          },
        },
      },
    });

    return publications.map((publication) => ({
      ...publication,
      latestMetrics: publication.metrics[0] ?? null,
      // An empty metrics array means nothing was ever collected for this post -
      // which is different from all-zero engagement.
      metricsAvailable: publication.metrics.length > 0,
      metrics: undefined,
    }));
  }

  async campaignAnalytics(auth: AuthContext) {
    return this.prisma.campaignMetric.findMany({
      where: scoped(auth),
      orderBy: { capturedAt: 'desc' },
      take: 200,
      select: {
        id: true,
        campaignId: true,
        capturedAt: true,
        postCount: true,
        impressions: true,
        engagements: true,
        clicks: true,
        engagementRate: true,
        campaign: { select: { id: true, name: true, status: true } },
      },
    });
  }

  async platformAnalytics(auth: AuthContext) {
    return this.prisma.platformMetric.findMany({
      where: scoped(auth),
      orderBy: { capturedAt: 'desc' },
      take: 200,
    });
  }

  /** Enqueues a performance review that produces StrategyInsight proposals. */
  async runPerformanceReview(auth: AuthContext, periodDays: number) {
    const execution = await this.prisma.workflowExecution.create({
      data: {
        organizationId: auth.organizationId,
        workflowName: WORKFLOW_NAMES.performanceReview,
        status: 'PENDING',
        input: { periodDays },
        correlationId: auth.requestId,
        triggeredById: auth.userId,
        triggeredByType: 'USER',
        steps: [],
      },
      select: { id: true },
    });

    await this.queues.enqueue(
      QUEUE_NAMES.analytics,
      'performance-review',
      {
        organizationId: auth.organizationId,
        workflowExecutionId: execution.id,
        periodDays,
        triggeredByUserId: auth.userId,
        correlationId: auth.requestId,
      },
      { jobId: `review:${execution.id}` },
    );

    return { workflowExecutionId: execution.id, status: 'PENDING' as const };
  }

  // -- Strategy insights ----------------------------------------------------

  async listInsights(auth: AuthContext, status?: 'PROPOSED' | 'ACCEPTED' | 'REJECTED') {
    return this.prisma.strategyInsight.findMany({
      where: scoped(auth, { ...(status ? { status } : {}) }),
      orderBy: [{ status: 'asc' }, { confidence: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      select: {
        id: true,
        type: true,
        evidence: true,
        confidence: true,
        recommendation: true,
        supportingContentIds: true,
        status: true,
        decidedAt: true,
        createdAt: true,
        decidedBy: { select: { id: true, displayName: true } },
      },
    });
  }

  /**
   * Accepts or rejects an insight.
   *
   * Accepting is what promotes a measured observation into strategy memory. It
   * is always a human decision: nothing in the system flips this automatically.
   */
  async decideInsight(auth: AuthContext, id: string, decision: 'ACCEPTED' | 'REJECTED') {
    const insight = await this.prisma.strategyInsight.findUnique({
      where: { id },
      select: { id: true, organizationId: true, status: true },
    });
    requireInOrg(insight, auth, 'Strategy insight');

    return this.prisma.strategyInsight.update({
      where: { id },
      data: { status: decision, decidedById: auth.userId, decidedAt: new Date() },
      select: { id: true, status: true, decidedAt: true },
    });
  }

  // -- Agents ---------------------------------------------------------------

  async listAgents() {
    return this.prisma.agent.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        modelTier: true,
        timeoutMs: true,
        maxRetries: true,
        toolNames: true,
        enabled: true,
      },
    });
  }

  async getAgent(auth: AuthContext, id: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        systemInstructions: true,
        modelTier: true,
        timeoutMs: true,
        maxRetries: true,
        toolNames: true,
        inputSchema: true,
        outputSchema: true,
        enabled: true,
      },
    });
    if (!agent) return null;

    const recentExecutions = await this.prisma.agentExecution.count({
      where: scoped(auth, { agentName: agent.name }),
    });

    return { ...agent, executionCount: recentExecutions };
  }

  /** Agent activity feed, scoped to the organization. */
  async listExecutions(
    auth: AuthContext,
    query: { agentName?: string; limit: number; workflowExecutionId?: string },
  ) {
    return this.prisma.agentExecution.findMany({
      where: scoped(auth, {
        ...(query.agentName ? { agentName: query.agentName } : {}),
        ...(query.workflowExecutionId ? { workflowExecutionId: query.workflowExecutionId } : {}),
      }),
      orderBy: { startedAt: 'desc' },
      take: query.limit,
      select: {
        id: true,
        agentName: true,
        status: true,
        model: true,
        latencyMs: true,
        totalTokens: true,
        error: true,
        startedAt: true,
        finishedAt: true,
        correlationId: true,
        workflowExecutionId: true,
        triggeredBy: { select: { id: true, displayName: true } },
        triggeredByType: true,
        _count: { select: { toolCalls: true } },
      },
    });
  }

  async getExecution(auth: AuthContext, id: string) {
    const execution = await this.prisma.agentExecution.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        agentName: true,
        status: true,
        model: true,
        input: true,
        output: true,
        error: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        latencyMs: true,
        startedAt: true,
        finishedAt: true,
        correlationId: true,
        toolCalls: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            toolName: true,
            arguments: true,
            result: true,
            status: true,
            error: true,
            latencyMs: true,
            createdAt: true,
          },
        },
      },
    });
    return requireInOrg(execution, auth, 'Agent execution');
  }

  // -- Notifications --------------------------------------------------------

  async listNotifications(auth: AuthContext, unreadOnly: boolean) {
    return this.prisma.notification.findMany({
      where: scoped(auth, {
        OR: [{ userId: auth.userId }, { userId: null }],
        ...(unreadOnly ? { readAt: null } : {}),
      }),
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        type: true,
        severity: true,
        title: true,
        body: true,
        resourceType: true,
        resourceId: true,
        readAt: true,
        createdAt: true,
      },
    });
  }

  async markNotificationsRead(auth: AuthContext, ids: string[]): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: scoped(auth, {
        id: { in: ids },
        OR: [{ userId: auth.userId }, { userId: null }],
        readAt: null,
      }),
      data: { readAt: new Date() },
    });
    return result.count;
  }

  // -- Dashboard ------------------------------------------------------------

  /** Everything the dashboard needs, in one round trip. */
  async dashboard(auth: AuthContext) {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const weekAhead = new Date(now.getTime() + 7 * 86_400_000);

    const [
      topOpportunities,
      opportunityCount,
      trends,
      upcoming,
      needsApproval,
      recentPublications,
      failedPublications,
      connections,
      agentActivity,
      insights,
    ] = await Promise.all([
      this.prisma.opportunity.findMany({
        where: scoped(auth, {
          status: { in: ['NEW', 'REVIEWED', 'SELECTED'] as OpportunityStatus[] },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        }),
        orderBy: { opportunityScore: 'desc' },
        take: 5,
        select: {
          id: true,
          title: true,
          description: true,
          opportunityScore: true,
          trendScore: true,
          relevanceScore: true,
          competitionScore: true,
          riskScore: true,
          platform: true,
          contentFormat: true,
          recommendedAction: true,
          expiresAt: true,
        },
      }),
      this.prisma.opportunity.count({
        where: scoped(auth, {
          status: { in: ['NEW', 'REVIEWED'] as OpportunityStatus[] },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        }),
      }),
      this.prisma.trend.findMany({
        where: scoped(auth, { status: { in: ['EMERGING', 'ACTIVE'] as TrendStatus[] } }),
        orderBy: { score: 'desc' },
        take: 6,
        select: { id: true, name: true, score: true, summary: true, status: true, lastSeenAt: true },
      }),
      this.prisma.contentItem.findMany({
        where: scoped(auth, {
          status: 'SCHEDULED' as const,
          scheduledAt: { gte: now, lte: weekAhead },
        }),
        orderBy: { scheduledAt: 'asc' },
        take: 10,
        select: {
          id: true,
          title: true,
          contentType: true,
          scheduledAt: true,
          status: true,
          campaign: { select: { id: true, name: true } },
        },
      }),
      this.prisma.contentItem.findMany({
        where: scoped(auth, { status: 'PENDING_APPROVAL' as const }),
        orderBy: { createdAt: 'asc' },
        take: 10,
        select: {
          id: true,
          title: true,
          contentType: true,
          riskLevel: true,
          flaggedTopics: true,
          createdAt: true,
        },
      }),
      this.prisma.publication.findMany({
        where: scoped(auth, { status: 'SUCCEEDED' as const }),
        orderBy: { publishedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          provider: true,
          providerUrl: true,
          publishedAt: true,
          contentItem: { select: { id: true, title: true, contentType: true } },
          metrics: {
            orderBy: { capturedAt: 'desc' },
            take: 1,
            select: { impressions: true, likes: true, comments: true, engagementRate: true },
          },
        },
      }),
      this.prisma.publication.count({ where: scoped(auth, { status: 'FAILED' as const }) }),
      this.prisma.socialConnection.findMany({
        where: scoped(auth),
        select: {
          id: true,
          provider: true,
          accountName: true,
          status: true,
          expiresAt: true,
          lastValidatedAt: true,
          lastErrorMessage: true,
        },
      }),
      this.prisma.agentExecution.findMany({
        where: scoped(auth, { startedAt: { gte: dayAgo } }),
        orderBy: { startedAt: 'desc' },
        take: 15,
        select: {
          id: true,
          agentName: true,
          status: true,
          startedAt: true,
          latencyMs: true,
          output: true,
        },
      }),
      this.prisma.strategyInsight.findMany({
        where: scoped(auth, { status: 'PROPOSED' as const }),
        orderBy: { confidence: 'desc' },
        take: 5,
        select: { id: true, type: true, recommendation: true, confidence: true },
      }),
    ]);

    return {
      opportunities: { top: topOpportunities, openCount: opportunityCount },
      trends,
      upcomingContent: upcoming,
      needsApproval,
      publishing: {
        recent: recentPublications.map((publication) => ({
          ...publication,
          latestMetrics: publication.metrics[0] ?? null,
          metrics: undefined,
        })),
        failedCount: failedPublications,
      },
      connections: connections.map((connection) => ({
        ...connection,
        tokenExpired: connection.expiresAt ? connection.expiresAt.getTime() < now.getTime() : false,
      })),
      agentActivity,
      proposedInsights: insights,
    };
  }
}

/**
 * Sums values that may be absent.
 * Returns null when nothing was measured, so "no data" never renders as zero.
 */
function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}
