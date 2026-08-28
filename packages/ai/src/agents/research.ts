import { z } from 'zod';
import {
  growthScore,
  recencyScore,
  saturating,
  scoreNiche,
  scoreTrend,
  velocityScore,
} from '@kult/shared';
import { renderBrandContext, FACTUALITY_RULES } from '../grounding.js';
import {
  competitorResearchSchema,
  nicheDiscoverySchema,
  scoreExplanationSchema,
  trendDetectionSchema,
  webResearchResultSchema,
} from '../schemas.js';
import { UNTRUSTED_CONTENT_PREAMBLE, detectInjectionAttempt, wrapUntrusted } from '../safety.js';
import { Agent, type AgentContext, type AgentDefinition } from './base.js';

/**
 * Research agents.
 *
 * The division of labour throughout: measured signals produce the score in code,
 * and the model supplies qualitative judgement plus the explanation. No agent is
 * asked "what is the trend score" - it is asked "how relevant is this to this
 * brand", and arithmetic does the rest.
 */

// ---------------------------------------------------------------------------
// TrendResearchAgent
// ---------------------------------------------------------------------------

const trendResearchInput = z.object({
  /** Research items already collected and persisted by the source adapters. */
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      url: z.string().nullable(),
      publishedAt: z.coerce.date().nullable(),
      engagement: z.record(z.string(), z.number()).default({}),
      sourceType: z.string(),
    }),
  ),
  /** Items collected in the preceding window, used to compute growth. */
  previousWindowItemCount: z.number().int().min(0).default(0),
  windowHours: z.number().positive().default(72),
  maxTrends: z.number().int().min(1).max(25).default(8),
});

const trendResearchOutput = z.object({
  trends: z.array(
    z.object({
      name: z.string(),
      slug: z.string(),
      summary: z.string(),
      rationale: z.string(),
      keywords: z.array(z.string()),
      score: z.number(),
      components: z.record(z.string(), z.number()),
      contributions: z.record(z.string(), z.number()),
      supportingItemIds: z.array(z.string()),
      riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    }),
  ),
  injectionAttemptsDetected: z.array(z.object({ itemId: z.string(), labels: z.array(z.string()) })),
});

export class TrendResearchAgent extends Agent<
  typeof trendResearchInput,
  typeof trendResearchOutput
> {
  readonly definition: AgentDefinition<typeof trendResearchInput, typeof trendResearchOutput> = {
    name: 'TrendResearchAgent',
    description:
      'Clusters collected research items into named trends, judges brand relevance, and scores ' +
      'each trend deterministically from measured velocity, growth, engagement, and recency.',
    inputSchema: trendResearchInput,
    outputSchema: trendResearchOutput,
    modelTier: 'reasoning',
    timeoutMs: 180_000,
    maxRetries: 2,
    toolNames: [],
    usesWebSearch: false,
  };

  protected async execute(
    context: AgentContext,
    input: z.infer<typeof trendResearchInput>,
  ): Promise<z.infer<typeof trendResearchOutput>> {
    if (input.items.length === 0) {
      return { trends: [], injectionAttemptsDetected: [] };
    }

    // Record hostile content for operators without letting it change behaviour.
    const injectionAttemptsDetected = input.items
      .map((item) => ({
        itemId: item.id,
        labels: detectInjectionAttempt(`${item.title}\n${item.body ?? ''}`),
      }))
      .filter((entry) => entry.labels.length > 0);

    const brand = await context.brand.load(
      context.organizationId,
      input.items
        .slice(0, 10)
        .map((item) => item.title)
        .join(' '),
    );

    const corpus = input.items
      .map((item) =>
        wrapUntrusted(
          `${item.sourceType}:${item.id}`,
          [
            `ID: ${item.id}`,
            `URL: ${item.url ?? 'none'}`,
            `PUBLISHED: ${item.publishedAt?.toISOString() ?? 'unknown'}`,
            `TITLE: ${item.title}`,
            item.body ? `BODY: ${item.body.slice(0, 1_200)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          1_600,
        ),
      )
      .join('\n\n');

    const assessment = await context.ai.generateStructured({
      schemaName: 'trend_detection',
      schema: trendDetectionSchema,
      tier: this.definition.modelTier,
      instructions: [
        UNTRUSTED_CONTENT_PREAMBLE,
        '',
        'You are a marketing trend analyst. Group the supplied research items into at most ' +
          `${input.maxTrends} distinct, specific trends. A trend must be supported by at least one ` +
          'supplied item; cite those items by their exact URL in supportingItemUrls.',
        '',
        'Name trends specifically ("AI agents as playable game characters"), never generically ("AI").',
        'Judge relevance and audience overlap against the brand context below.',
        'Do not invent trends that the supplied items do not evidence.',
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: corpus,
      maxOutputTokens: 8_000,
    });

    const now = new Date();
    const byUrl = new Map(input.items.filter((item) => item.url).map((item) => [item.url as string, item]));

    const trends = assessment.data.trends.map((trend) => {
      const supporting = trend.supportingItemUrls
        .map((url) => byUrl.get(url))
        .filter((item): item is (typeof input.items)[number] => Boolean(item));

      // Measured signals, computed from the items - never asked of the model.
      const engagementTotal = supporting.reduce(
        (sum, item) => sum + Object.values(item.engagement).reduce((a, b) => a + b, 0),
        0,
      );
      const recency = supporting.length
        ? Math.max(
            ...supporting.map((item) =>
              item.publishedAt ? recencyScore(item.publishedAt, now) : 40,
            ),
          )
        : 0;

      const scored = scoreTrend({
        velocity: velocityScore(supporting.length, input.windowHours, 0.25),
        growth: growthScore(supporting.length, input.previousWindowItemCount / Math.max(1, assessment.data.trends.length)),
        engagement: saturating(engagementTotal, 250),
        recency,
        relevance: trend.relevanceToBrand,
        audienceOverlap: trend.audienceOverlap,
        competition: trend.competitionLevel,
        saturation: trend.contentSaturation,
        risk: trend.brandSafetyRisk,
      });

      return {
        name: trend.name,
        slug: trend.slug,
        summary: trend.summary,
        // Filled in below by the explanation pass.
        rationale: '',
        keywords: trend.keywords,
        score: scored.score,
        components: scored.components as unknown as Record<string, number>,
        contributions: scored.contributions as Record<string, number>,
        supportingItemIds: supporting.map((item) => item.id),
        riskLevel: trend.riskLevel,
      };
    });

    // Explain the computed scores. The model receives the numbers; it does not
    // produce them, so an explanation can never silently change a score.
    for (const trend of trends) {
      const explanation = await context.ai.generateStructured({
        schemaName: 'score_explanation',
        schema: scoreExplanationSchema,
        tier: 'fast',
        instructions:
          'Explain a trend score that has already been calculated. Use only the supplied component ' +
          'values. Do not recalculate, dispute, or restate the score as a different number.',
        input: JSON.stringify({
          trend: trend.name,
          summary: trend.summary,
          score: trend.score,
          components: trend.components,
          contributions: trend.contributions,
          evidenceCount: trend.supportingItemIds.length,
        }),
        maxOutputTokens: 700,
      });
      trend.rationale = explanation.data.rationale;
    }

    return { trends, injectionAttemptsDetected };
  }
}

// ---------------------------------------------------------------------------
// NicheDiscoveryAgent
// ---------------------------------------------------------------------------

const nicheInput = z.object({
  trends: z.array(z.object({ name: z.string(), summary: z.string(), keywords: z.array(z.string()) })),
  maxNiches: z.number().int().min(1).max(20).default(6),
});

const nicheOutput = z.object({
  niches: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      rationale: z.string(),
      parentNicheName: z.string().nullable(),
      audienceDescription: z.string(),
      score: z.number(),
      components: z.record(z.string(), z.number()),
      contributions: z.record(z.string(), z.number()),
    }),
  ),
});

export class NicheDiscoveryAgent extends Agent<typeof nicheInput, typeof nicheOutput> {
  readonly definition: AgentDefinition<typeof nicheInput, typeof nicheOutput> = {
    name: 'NicheDiscoveryAgent',
    description:
      'Derives specific micro-niches from detected trends and scores each on relevance, growth, ' +
      'audience fit, and competition.',
    inputSchema: nicheInput,
    outputSchema: nicheOutput,
    modelTier: 'reasoning',
    timeoutMs: 120_000,
    maxRetries: 2,
    toolNames: [],
    usesWebSearch: false,
  };

  protected async execute(
    context: AgentContext,
    input: z.infer<typeof nicheInput>,
  ): Promise<z.infer<typeof nicheOutput>> {
    const brand = await context.brand.load(
      context.organizationId,
      input.trends.map((trend) => trend.name).join(' '),
    );

    const result = await context.ai.generateStructured({
      schemaName: 'niche_discovery',
      schema: nicheDiscoverySchema,
      tier: this.definition.modelTier,
      instructions: [
        `Identify at most ${input.maxNiches} specific micro-niches this brand could credibly own.`,
        '',
        'Move from broad to narrow, for example: Gaming -> AI gaming -> autonomous agents ->',
        'AI agents playing games -> agentic game development. A niche must be narrow enough that a',
        'small team can become the recognised voice in it.',
        '',
        'Explain, for each, why it matters to THIS brand specifically. Generic reasoning is a failure.',
        '',
        FACTUALITY_RULES,
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: JSON.stringify({ trends: input.trends }),
      maxOutputTokens: 6_000,
    });

    return {
      niches: result.data.niches.map((niche) => {
        const scored = scoreNiche({
          relevance: niche.relevance,
          trendVelocity: niche.trendVelocity,
          growthSignal: niche.growthSignal,
          audienceFit: niche.audienceFit,
          competition: niche.competition,
        });
        return {
          name: niche.name,
          description: niche.description,
          rationale: niche.rationale,
          parentNicheName: niche.parentNicheName,
          audienceDescription: niche.audienceDescription,
          score: scored.score,
          components: scored.components as unknown as Record<string, number>,
          contributions: scored.contributions as Record<string, number>,
        };
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// CompetitorResearchAgent
// ---------------------------------------------------------------------------

const competitorInput = z.object({
  competitorNames: z.array(z.string()).min(1),
  /** Pre-collected public material about the competitors. */
  observations: z
    .array(z.object({ competitorName: z.string(), title: z.string(), url: z.string().nullable(), body: z.string() }))
    .default([]),
  useWebSearch: z.boolean().default(true),
});

export class CompetitorResearchAgent extends Agent<
  typeof competitorInput,
  typeof competitorResearchSchema
> {
  readonly definition: AgentDefinition<typeof competitorInput, typeof competitorResearchSchema> = {
    name: 'CompetitorResearchAgent',
    description:
      'Analyses competitor content and positioning, and identifies the gaps this brand can occupy.',
    inputSchema: competitorInput,
    outputSchema: competitorResearchSchema,
    modelTier: 'default',
    timeoutMs: 180_000,
    maxRetries: 2,
    toolNames: [],
    usesWebSearch: true,
  };

  protected async execute(
    context: AgentContext,
    input: z.infer<typeof competitorInput>,
  ): Promise<z.infer<typeof competitorResearchSchema>> {
    const brand = await context.brand.load(context.organizationId, input.competitorNames.join(' '));

    const material =
      input.observations.length > 0
        ? input.observations
            .map((observation) =>
              wrapUntrusted(
                observation.competitorName,
                `URL: ${observation.url ?? 'none'}\nTITLE: ${observation.title}\n${observation.body}`,
                2_000,
              ),
            )
            .join('\n\n')
        : '(No pre-collected material. Use web search to find recent public activity.)';

    const result = await context.ai.generateStructured({
      schemaName: 'competitor_research',
      schema: competitorResearchSchema,
      tier: this.definition.modelTier,
      webSearch: input.useWebSearch,
      instructions: [
        UNTRUSTED_CONTENT_PREAMBLE,
        '',
        'Analyse these competitors: ' + input.competitorNames.join(', ') + '.',
        'For each, describe observed content themes, cadence, and the gap this brand could fill.',
        '',
        'Include a sourceUrl only for something you actually retrieved. If you did not retrieve a',
        'source, set sourceUrl to null. Never construct a plausible-looking URL.',
        'Do not make accusations about competitors; describe observable positioning only.',
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: material,
      maxOutputTokens: 6_000,
    });

    return result.data;
  }
}

// ---------------------------------------------------------------------------
// Web research source, backed by the provider's hosted web search
// ---------------------------------------------------------------------------

/**
 * The WEB research source adapter.
 *
 * Lives in this package because it is powered by the model provider's hosted
 * web search. Only URLs the search tool actually returned as citations are kept:
 * a URL the model merely wrote in prose is discarded, because those can be
 * fabricated and would become false evidence on a trend.
 */
export function createWebResearchAdapter(deps: {
  ai: import('../service.js').AIService;
}): import('@kult/integrations').ResearchSourceAdapter {
  return {
    type: 'WEB' as const,
    availability() {
      return deps.ai.webSearchEnabled
        ? { available: true }
        : {
            available: false,
            reason:
              'Hosted web search is disabled for this deployment. Set AI_WEB_SEARCH_ENABLED=true to ' +
              'enable the WEB research source.',
            requiredVariables: ['AI_WEB_SEARCH_ENABLED'],
          };
    },
    async collect(options) {
      const queries = Array.isArray(options.config.queries)
        ? (options.config.queries as unknown[]).filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [];

      const collected: import('@kult/integrations').CollectedItem[] = [];

      for (const query of queries) {
        if (collected.length >= options.limit) break;

        const result = await deps.ai.generateStructured({
          schemaName: 'web_research',
          schema: webResearchResultSchema,
          tier: 'default',
          webSearch: true,
          instructions:
            'Search the web for recent, substantive material on the supplied topic. Return only ' +
            'results you actually retrieved, each with its real URL, a factual summary, keywords, ' +
            'entities, and sentiment. Never invent a URL or summarise a page you did not retrieve.',
          input: `Topic: ${query}\nOnly include material published recently and relevant to marketing strategy.`,
          maxOutputTokens: 4_000,
        });

        // Only citation-backed URLs count as evidence.
        const citedUrls = new Set(result.citations.map((citation) => citation.url));

        for (const item of result.data.items) {
          if (collected.length >= options.limit) break;
          if (!citedUrls.has(item.url)) continue;

          collected.push({
            url: item.url,
            title: item.title,
            body: item.summary,
            engagement: {},
            raw: {
              query,
              keywords: item.keywords,
              entities: item.entities,
              sentiment: item.sentiment,
              topic: item.topic,
              retrievedVia: 'hosted-web-search',
            },
          });
        }
      }

      return collected;
    },
  };
}
