import type { Job } from 'bullmq';
import { agents } from '@kult/ai';
import type { CollectedItem } from '@kult/integrations';
import { canonicalizeUrl, researchItemHash } from '@kult/shared';
import { agentContext, type WorkerContext } from '../context.js';
import { runResearchJob } from '../jobs.js';
import { notify } from '../lib/notify.js';
import type { JobLogger } from '../logger.js';

/**
 * Research collection and trend detection.
 *
 * Runs as an orchestrated workflow so each step's state is written to the
 * database as it happens: a run that dies halfway leaves a WorkflowExecution
 * showing exactly which step failed and why, rather than vanishing.
 *
 * Collection is deliberately fault-tolerant per source. One broken RSS feed or
 * an expired API key must not abort the whole run; the failure is recorded
 * against that source and the remaining sources still contribute.
 */
export async function processRunResearch(
  context: WorkerContext,
  job: Job,
  log: JobLogger,
): Promise<{ collected: number; trends: number; niches: number }> {
  const payload = runResearchJob.parse(job.data);

  const state = {
    workflowExecutionId: payload.workflowExecutionId,
    collectedItemIds: [] as string[],
    trendCount: 0,
    nicheCount: 0,
  };

  const result = await context.orchestrator.execute(
    {
      name: 'daily-research',
      description: 'Collect research, detect trends, discover niches.',
      steps: [
        {
          name: 'collect-research',
          run: async () => {
            const collected = await collectFromSources(context, payload, log);
            state.collectedItemIds = collected.itemIds;
            return {
              itemsCollected: collected.itemIds.length,
              sourcesRun: collected.sourcesRun,
              sourcesFailed: collected.sourcesFailed,
            };
          },
        },
        {
          name: 'detect-trends',
          // Nothing collected means nothing to cluster; skip rather than call the model.
          shouldRun: () => state.collectedItemIds.length > 0,
          run: async () => {
            state.trendCount = await detectTrends(context, payload, state.collectedItemIds, log);
            return { trendsDetected: state.trendCount };
          },
        },
        {
          name: 'discover-niches',
          shouldRun: () => state.trendCount > 0,
          run: async () => {
            state.nicheCount = await discoverNiches(context, payload, log);
            return { nichesDiscovered: state.nicheCount };
          },
        },
      ],
    },
    state,
    payload.workflowExecutionId,
  );

  if (result.status === 'SUCCEEDED') {
    await notify(context, {
      organizationId: payload.organizationId,
      ...(payload.triggeredByUserId ? { userId: payload.triggeredByUserId } : {}),
      type: 'RESEARCH_COMPLETED',
      title: 'Research run finished',
      body:
        `Collected ${state.collectedItemIds.length} new items, detected ${state.trendCount} trends, ` +
        `discovered ${state.nicheCount} niches.`,
      resourceType: 'WorkflowExecution',
      resourceId: payload.workflowExecutionId,
    });
  }

  return {
    collected: state.collectedItemIds.length,
    trends: state.trendCount,
    niches: state.nicheCount,
  };
}

/**
 * Collects from every requested source and persists deduplicated items.
 *
 * Deduplication is on (organizationId, hash), where the hash is the canonical
 * URL when there is one and normalised content otherwise. The same article
 * arriving from two feeds therefore stores once.
 */
async function collectFromSources(
  context: WorkerContext,
  payload: { organizationId: string; sourceIds: string[] },
  log: JobLogger,
): Promise<{ itemIds: string[]; sourcesRun: number; sourcesFailed: number }> {
  const sources = await context.prisma.researchSource.findMany({
    where: {
      organizationId: payload.organizationId,
      id: { in: payload.sourceIds },
      status: 'ACTIVE',
    },
    select: { id: true, type: true, name: true, config: true, lastRunAt: true },
  });

  const itemIds: string[] = [];
  let sourcesRun = 0;
  let sourcesFailed = 0;

  for (const source of sources) {
    const adapter = context.research.get(source.type);
    if (!adapter) {
      await markSourceUnavailable(
        context,
        source.id,
        `No adapter is registered for the ${source.type} source type.`,
      );
      sourcesFailed += 1;
      continue;
    }

    const availability = adapter.availability();
    if (!availability.available) {
      await markSourceUnavailable(
        context,
        source.id,
        availability.reason ?? `${source.type} is not available.`,
      );
      sourcesFailed += 1;
      continue;
    }

    try {
      const collected = await adapter.collect({
        config: (source.config ?? {}) as Record<string, unknown>,
        // Only look for material newer than the last successful run.
        ...(source.lastRunAt ? { since: source.lastRunAt } : {}),
        limit: 100,
      });

      const stored = await persistItems(context, payload.organizationId, source, collected);
      itemIds.push(...stored);
      sourcesRun += 1;

      await context.prisma.researchSource.update({
        where: { id: source.id },
        data: {
          lastRunAt: new Date(),
          lastItemCount: stored.length,
          status: 'ACTIVE',
          unavailableReason: null,
        },
      });

      log.info(
        { sourceId: source.id, type: source.type, collected: collected.length, stored: stored.length },
        'Collected from research source',
      );
    } catch (error) {
      sourcesFailed += 1;
      const message = error instanceof Error ? error.message : String(error);

      // One failing source never aborts the run.
      await context.prisma.researchSource.update({
        where: { id: source.id },
        data: {
          status: 'ERROR',
          unavailableReason: message.slice(0, 1_000),
          lastRunAt: new Date(),
        },
      });

      log.warn({ sourceId: source.id, type: source.type, err: message }, 'Research source failed');
    }
  }

  return { itemIds, sourcesRun, sourcesFailed };
}

async function markSourceUnavailable(
  context: WorkerContext,
  sourceId: string,
  reason: string,
): Promise<void> {
  await context.prisma.researchSource.update({
    where: { id: sourceId },
    data: { status: 'UNAVAILABLE', unavailableReason: reason.slice(0, 1_000) },
  });
}

async function persistItems(
  context: WorkerContext,
  organizationId: string,
  source: { id: string; type: string },
  items: CollectedItem[],
): Promise<string[]> {
  const stored: string[] = [];

  for (const item of items) {
    const hash = researchItemHash({
      ...(item.url ? { url: item.url } : {}),
      title: item.title,
      ...(item.body ? { body: item.body } : {}),
    });

    let canonicalUrl: string | null = null;
    if (item.url) {
      try {
        canonicalUrl = canonicalizeUrl(item.url);
      } catch {
        canonicalUrl = null;
      }
    }

    try {
      // The unique constraint on (organizationId, hash) is what actually enforces
      // deduplication; createMany with skipDuplicates would not return ids.
      const created = await context.prisma.researchItem.create({
        data: {
          organizationId,
          sourceId: source.id,
          sourceType: source.type as never,
          hash,
          url: item.url ?? null,
          canonicalUrl,
          title: item.title.slice(0, 2_000),
          body: item.body?.slice(0, 20_000) ?? null,
          author: item.author?.slice(0, 300) ?? null,
          publishedAt: item.publishedAt ?? null,
          engagement: item.engagement as object,
          raw: item.raw as object,
        },
        select: { id: true },
      });
      stored.push(created.id);
    } catch {
      // Duplicate hash: the item is already known. Not an error.
    }
  }

  return stored;
}

/** Runs the TrendResearchAgent and persists trends with their real evidence. */
async function detectTrends(
  context: WorkerContext,
  payload: { organizationId: string; correlationId: string; triggeredByUserId?: string; workflowExecutionId: string },
  itemIds: string[],
  log: JobLogger,
): Promise<number> {
  const items = await context.prisma.researchItem.findMany({
    where: { organizationId: payload.organizationId, id: { in: itemIds } },
    select: {
      id: true,
      title: true,
      body: true,
      url: true,
      publishedAt: true,
      engagement: true,
      sourceType: true,
    },
    take: 300,
  });

  if (items.length === 0) return 0;

  const windowStart = new Date(Date.now() - 72 * 3_600_000);
  const previousWindowItemCount = await context.prisma.researchItem.count({
    where: {
      organizationId: payload.organizationId,
      collectedAt: { gte: new Date(windowStart.getTime() - 72 * 3_600_000), lt: windowStart },
    },
  });

  const { output } = await context.agents.run(
    agents.TrendResearchAgent,
    agentContext(context, payload),
    {
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        url: item.url,
        publishedAt: item.publishedAt,
        engagement: normaliseEngagement(item.engagement),
        sourceType: item.sourceType,
      })),
      previousWindowItemCount,
      windowHours: 72,
      maxTrends: 8,
    },
  );

  if (output.injectionAttemptsDetected.length > 0) {
    // Recorded, not acted on: the structural defence in the prompt is what
    // protects the model. This exists so operators can see hostile sources.
    log.warn(
      { count: output.injectionAttemptsDetected.length, items: output.injectionAttemptsDetected },
      'Prompt injection patterns detected in collected research',
    );
  }

  let persisted = 0;

  for (const trend of output.trends) {
    const slug = trend.slug.slice(0, 120);

    const row = await context.prisma.trend.upsert({
      where: { organizationId_slug: { organizationId: payload.organizationId, slug } },
      create: {
        organizationId: payload.organizationId,
        name: trend.name,
        slug,
        summary: trend.summary,
        rationale: trend.rationale,
        score: trend.score,
        components: trend.components as object,
        contributions: trend.contributions as object,
        keywords: trend.keywords,
        status: 'EMERGING',
        lastSeenAt: new Date(),
      },
      update: {
        name: trend.name,
        summary: trend.summary,
        rationale: trend.rationale,
        score: trend.score,
        components: trend.components as object,
        contributions: trend.contributions as object,
        keywords: trend.keywords,
        // Seeing it again keeps it alive; the expiry sweep handles decay.
        status: 'ACTIVE',
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });

    // Evidence links. The UI renders these, never the AI rationale, as evidence.
    for (const itemId of trend.supportingItemIds) {
      await context.prisma.trendSignal
        .create({ data: { trendId: row.id, researchItemId: itemId, weight: 1 } })
        .catch(() => undefined); // Already linked.
    }

    persisted += 1;
  }

  return persisted;
}

async function discoverNiches(
  context: WorkerContext,
  payload: { organizationId: string; correlationId: string; triggeredByUserId?: string; workflowExecutionId: string },
  log: JobLogger,
): Promise<number> {
  const trends = await context.prisma.trend.findMany({
    where: { organizationId: payload.organizationId, status: { in: ['EMERGING', 'ACTIVE'] } },
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

  let persisted = 0;

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
    persisted += 1;
  }

  log.info({ niches: persisted }, 'Discovered niches');
  return persisted;
}

/** Engagement is stored as free-form JSON; only numeric entries are usable. */
function normaliseEngagement(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) result[key] = entry;
  }
  return result;
}
