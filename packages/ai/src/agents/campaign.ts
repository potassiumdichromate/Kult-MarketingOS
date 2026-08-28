import { z } from 'zod';
import { FACTUALITY_RULES, renderBrandContext } from '../grounding.js';
import { campaignPlanSchema, performanceAnalysisSchema, strategyInsightSchema } from '../schemas.js';
import { Agent, type AgentContext, type AgentDefinition } from './base.js';

/**
 * Campaign, analytics, and optimization agents.
 *
 * The analytics agents operate strictly on metrics this system actually holds.
 * Where a provider does not expose a metric (LinkedIn per-post engagement, for
 * example) the corresponding rows are simply absent, and the prompt says so, so
 * the model reports a gap rather than inferring numbers.
 */

// ---------------------------------------------------------------------------
// CampaignAgent
// ---------------------------------------------------------------------------

const campaignInput = z.object({
  goal: z.string(),
  template: z.string().nullable().default(null),
  durationDays: z.number().int().min(1).max(90).default(14),
  platforms: z.array(z.enum(['X', 'INSTAGRAM', 'LINKEDIN'])).min(1),
  audienceName: z.string().nullable().default(null),
  /** Opportunities the campaign should build on, if any were selected. */
  opportunities: z
    .array(z.object({ title: z.string(), description: z.string() }))
    .default([]),
  postsPerWeek: z.number().int().min(1).max(30).default(5),
});

export class CampaignAgent extends Agent<typeof campaignInput, typeof campaignPlanSchema> {
  readonly definition: AgentDefinition<typeof campaignInput, typeof campaignPlanSchema> = {
    name: 'CampaignAgent',
    description:
      'Builds a complete campaign plan: strategy, content pillars, platform allocation, and a ' +
      'day-by-day content calendar of concepts.',
    inputSchema: campaignInput,
    outputSchema: campaignPlanSchema,
    modelTier: 'reasoning',
    timeoutMs: 240_000,
    maxRetries: 2,
    toolNames: [],
    usesWebSearch: false,
  };

  protected async execute(
    context: AgentContext,
    input: z.infer<typeof campaignInput>,
  ): Promise<z.infer<typeof campaignPlanSchema>> {
    const brand = await context.brand.load(context.organizationId, input.goal);

    const targetPostCount = Math.max(
      1,
      Math.round((input.durationDays / 7) * input.postsPerWeek),
    );

    const result = await context.ai.generateStructured({
      schemaName: 'campaign_plan',
      schema: campaignPlanSchema,
      tier: this.definition.modelTier,
      instructions: [
        `Design a ${input.durationDays}-day campaign for this goal: ${input.goal}`,
        input.template ? `Campaign template: ${input.template}.` : '',
        '',
        `Produce roughly ${targetPostCount} calendar entries across ${input.platforms.join(', ')}.`,
        'Use dayOffset (0 = start date) rather than absolute dates.',
        '',
        'Build the calendar around three to five content pillars, and vary format and angle so the',
        'campaign does not read as the same post repeated. Front-load the strongest concepts.',
        'Every entry needs a concrete concept and a specific hook, not a topic label.',
        '',
        FACTUALITY_RULES,
        '',
        renderBrandContext(brand),
      ]
        .filter(Boolean)
        .join('\n'),
      input: JSON.stringify({
        goal: input.goal,
        platforms: input.platforms,
        audience: input.audienceName,
        opportunities: input.opportunities,
        durationDays: input.durationDays,
      }),
      maxOutputTokens: 12_000,
    });

    // dayOffset must stay inside the campaign window.
    return {
      ...result.data,
      calendar: result.data.calendar.filter((entry) => entry.dayOffset < input.durationDays),
    };
  }
}

// ---------------------------------------------------------------------------
// AnalyticsAgent
// ---------------------------------------------------------------------------

const analyticsInput = z.object({
  periodDays: z.number().int().min(1).max(365).default(30),
  posts: z.array(
    z.object({
      contentItemId: z.string(),
      platform: z.string(),
      contentType: z.string(),
      hook: z.string(),
      publishedAt: z.coerce.date(),
      publishedHourLocal: z.number().int().min(0).max(23),
      topics: z.array(z.string()),
      cta: z.string().nullable(),
      metrics: z.record(z.string(), z.number().nullable()),
    }),
  ),
  /** Platforms whose metrics could not be collected, and why. */
  metricGaps: z.array(z.object({ platform: z.string(), reason: z.string() })).default([]),
  baselines: z.record(z.string(), z.number()).default({}),
});

export class AnalyticsAgent extends Agent<typeof analyticsInput, typeof performanceAnalysisSchema> {
  readonly definition: AgentDefinition<typeof analyticsInput, typeof performanceAnalysisSchema> = {
    name: 'AnalyticsAgent',
    description:
      'Analyses published-post performance to identify what works: hooks, formats, platforms, ' +
      'posting windows, topics, and CTAs.',
    inputSchema: analyticsInput,
    outputSchema: performanceAnalysisSchema,
    modelTier: 'reasoning',
    timeoutMs: 180_000,
    maxRetries: 2,
    toolNames: [],
    usesWebSearch: false,
  };

  protected async execute(
    context: AgentContext,
    input: z.infer<typeof analyticsInput>,
  ): Promise<z.infer<typeof performanceAnalysisSchema>> {
    if (input.posts.length === 0) {
      return {
        summary:
          'No published posts with collected metrics fall inside this period, so no performance ' +
          'conclusions can be drawn yet.',
        bestHooks: [],
        bestFormats: [],
        bestPlatforms: [],
        bestPostingWindows: [],
        bestTopics: [],
        bestCtas: [],
        strongestNiches: [],
        weakPatterns: [],
        decliningTopics: [],
        emergingTopics: [],
        recommendations: [],
      };
    }

    const brand = await context.brand.load(context.organizationId);

    const gapNote =
      input.metricGaps.length > 0
        ? 'METRIC GAPS - these platforms returned no metrics, so draw no conclusions about them:\n' +
          input.metricGaps.map((gap) => `- ${gap.platform}: ${gap.reason}`).join('\n')
        : '';

    const result = await context.ai.generateStructured({
      schemaName: 'performance_analysis',
      schema: performanceAnalysisSchema,
      tier: this.definition.modelTier,
      instructions: [
        `Analyse the last ${input.periodDays} days of published content.`,
        '',
        'Ground every statement in the supplied metrics. A null metric means the platform did not',
        'report it - treat it as unknown, never as zero.',
        '',
        `The sample is ${input.posts.length} posts. Say so plainly when that is too small to`,
        'support a conclusion, and lower the confidence on any recommendation it rests on.',
        'Reference supporting posts by contentItemId.',
        '',
        gapNote,
        '',
        renderBrandContext(brand),
      ]
        .filter(Boolean)
        .join('\n'),
      input: JSON.stringify({ posts: input.posts, baselines: input.baselines }),
      maxOutputTokens: 8_000,
    });

    return result.data;
  }
}

// ---------------------------------------------------------------------------
// OptimizationAgent
// ---------------------------------------------------------------------------

const optimizationInput = z.object({
  analysis: performanceAnalysisSchema,
  /** Insights already accepted, so the agent does not re-propose them. */
  existingAcceptedInsights: z.array(z.string()).default([]),
  minimumSampleSize: z.number().int().min(1).default(5),
});

export class OptimizationAgent extends Agent<typeof optimizationInput, typeof strategyInsightSchema> {
  readonly definition: AgentDefinition<typeof optimizationInput, typeof strategyInsightSchema> = {
    name: 'OptimizationAgent',
    description:
      'Converts performance analysis into durable strategy insights that a human accepts or ' +
      'rejects. Never mutates brand policy on its own.',
    inputSchema: optimizationInput,
    outputSchema: strategyInsightSchema,
    modelTier: 'reasoning',
    timeoutMs: 150_000,
    maxRetries: 2,
    toolNames: [],
    usesWebSearch: false,
  };

  protected async execute(
    context: AgentContext,
    input: z.infer<typeof optimizationInput>,
  ): Promise<z.infer<typeof strategyInsightSchema>> {
    const brand = await context.brand.load(context.organizationId);

    const result = await context.ai.generateStructured({
      schemaName: 'strategy_insights',
      schema: strategyInsightSchema,
      tier: this.definition.modelTier,
      instructions: [
        'Propose durable strategy insights from the supplied performance analysis.',
        '',
        'An insight must generalise beyond a single post. One post performing well is an anecdote,',
        `not a pattern - require at least ${input.minimumSampleSize} supporting posts before`,
        'proposing a pattern, and set confidence accordingly.',
        '',
        'Do not repeat these already-accepted insights:',
        input.existingAcceptedInsights.length > 0
          ? input.existingAcceptedInsights.map((insight) => `- ${insight}`).join('\n')
          : '(none)',
        '',
        'Each insight is a proposal for a human to accept or reject. Write it as a recommendation,',
        'not as a change already made.',
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: JSON.stringify(input.analysis),
      maxOutputTokens: 5_000,
    });

    // A proposal below the evidence threshold is not surfaced at all.
    return {
      insights: result.data.insights.filter(
        (insight) => insight.supportingContentIds.length >= Math.min(input.minimumSampleSize, 3),
      ),
    };
  }
}
