import { z } from 'zod';
import { getCapability, scoreOpportunity, validateContent } from '@kult/shared';
import { FACTUALITY_RULES, renderBrandContext } from '../grounding.js';
import {
  brandCheckSchema,
  contentGenerationSchema,
  contentRewriteSchema,
  contentStrategySchema,
  factCheckSchema,
  hookVariantsSchema,
  multiPlatformStrategySchema,
  opportunityGenerationSchema,
  repurposeSchema,
} from '../schemas.js';
import { assessApproval, findForbiddenPhrases, verifyClaims } from '../safety.js';
import { Agent, type AgentContext, type AgentDefinition } from './base.js';

/**
 * Opportunity, strategy, and content agents.
 *
 * The content pipeline enforces a hard rule at generation time: the model's own
 * risk assessment is never the final word. Every generated piece is re-checked
 * server-side - claims matched against approved claims, forbidden phrasing
 * scanned, policy topics detected - and the approval requirement can only be
 * escalated by those checks, never relaxed.
 */

// ---------------------------------------------------------------------------
// OpportunityAgent
// ---------------------------------------------------------------------------

const opportunityInput = z.object({
  trends: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      summary: z.string(),
      score: z.number(),
      riskLevel: z.string(),
    }),
  ),
  niches: z.array(z.object({ name: z.string(), description: z.string(), score: z.number() })).default([]),
  /** Historical performance by platform/format, used for the historicalFit term. */
  historicalFit: z.record(z.string(), z.number()).default({}),
  maxOpportunities: z.number().int().min(1).max(20).default(7),
});

const opportunityOutput = z.object({
  opportunities: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      platform: z.enum(['X', 'INSTAGRAM', 'LINKEDIN']).nullable(),
      contentFormat: z.string().nullable(),
      marketingObjective: z.string().nullable(),
      recommendedAction: z.string(),
      rationale: z.string(),
      relevanceScore: z.number(),
      trendScore: z.number(),
      competitionScore: z.number(),
      riskScore: z.number(),
      opportunityScore: z.number(),
      components: z.record(z.string(), z.number()),
      contributions: z.record(z.string(), z.number()),
      sourceTrendSlugs: z.array(z.string()),
      sourceNicheNames: z.array(z.string()),
      expiresInHours: z.number().nullable(),
    }),
  ),
});

export class OpportunityAgent extends Agent<typeof opportunityInput, typeof opportunityOutput> {
  readonly definition: AgentDefinition<typeof opportunityInput, typeof opportunityOutput> = {
    name: 'OpportunityAgent',
    description:
      'Converts scored trends and niches into concrete, timely marketing opportunities with a ' +
      'deterministic opportunity score.',
    inputSchema: opportunityInput,
    outputSchema: opportunityOutput,
    modelTier: 'reasoning',
    timeoutMs: 150_000,
    maxRetries: 2,
    toolNames: [],
    usesWebSearch: false,
  };

  protected async execute(
    context: AgentContext,
    input: z.infer<typeof opportunityInput>,
  ): Promise<z.infer<typeof opportunityOutput>> {
    const brand = await context.brand.load(
      context.organizationId,
      input.trends.map((trend) => trend.name).join(' '),
    );

    const result = await context.ai.generateStructured({
      schemaName: 'opportunity_generation',
      schema: opportunityGenerationSchema,
      tier: this.definition.modelTier,
      instructions: [
        `Produce at most ${input.maxOpportunities} marketing opportunities answering one question:`,
        '"What should this brand talk about right now, and in what form?"',
        '',
        'Each opportunity must reference the trend slugs and niche names it derives from.',
        'Prefer specific, actionable angles over broad themes. Choose a platform and content format',
        'that genuinely fits the angle rather than defaulting to the same one each time.',
        '',
        FACTUALITY_RULES,
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: JSON.stringify({ trends: input.trends, niches: input.niches }),
      maxOutputTokens: 8_000,
    });

    const trendScoreBySlug = new Map(input.trends.map((trend) => [trend.slug, trend.score]));

    return {
      opportunities: result.data.opportunities.map((opportunity) => {
        // The supporting trend's already-computed score feeds the opportunity score.
        const supportingScores = opportunity.sourceTrendSlugs
          .map((slug) => trendScoreBySlug.get(slug))
          .filter((score): score is number => typeof score === 'number');
        const trendScore = supportingScores.length > 0 ? Math.max(...supportingScores) : 0;

        const historicalKey = `${opportunity.platform ?? 'ANY'}:${opportunity.contentFormat ?? 'ANY'}`;
        const historicalFit = input.historicalFit[historicalKey] ?? 50;

        const scored = scoreOpportunity({
          trendScore,
          relevanceScore: opportunity.relevance,
          competitionScore: opportunity.competition,
          riskScore: opportunity.risk,
          timeliness: opportunity.timeliness,
          historicalFit,
        });

        return {
          title: opportunity.title,
          description: opportunity.description,
          platform: opportunity.platform,
          contentFormat: opportunity.contentFormat,
          marketingObjective: opportunity.marketingObjective,
          recommendedAction: opportunity.recommendedAction,
          rationale: opportunity.rationale,
          relevanceScore: opportunity.relevance,
          trendScore,
          competitionScore: opportunity.competition,
          riskScore: opportunity.risk,
          opportunityScore: scored.score,
          components: scored.components as unknown as Record<string, number>,
          contributions: scored.contributions as Record<string, number>,
          sourceTrendSlugs: opportunity.sourceTrendSlugs,
          sourceNicheNames: opportunity.sourceNicheNames,
          expiresInHours: opportunity.expiresInHours,
        };
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// ContentStrategyAgent
// ---------------------------------------------------------------------------

const strategyInput = z.object({
  opportunityTitle: z.string(),
  opportunityDescription: z.string(),
  platforms: z.array(z.enum(['X', 'INSTAGRAM', 'LINKEDIN'])).min(1),
  audienceName: z.string().nullable().default(null),
});

export class ContentStrategyAgent extends Agent<
  typeof strategyInput,
  typeof multiPlatformStrategySchema
> {
  readonly definition: AgentDefinition<typeof strategyInput, typeof multiPlatformStrategySchema> = {
    name: 'ContentStrategyAgent',
    description:
      'Turns an opportunity into a per-platform strategy: objective, angle, hook, narrative, CTA, ' +
      'format, timing, and risk assessment.',
    inputSchema: strategyInput,
    outputSchema: multiPlatformStrategySchema,
    modelTier: 'default',
    timeoutMs: 120_000,
    maxRetries: 2,
    toolNames: [],
    usesWebSearch: false,
  };

  protected async execute(
    context: AgentContext,
    input: z.infer<typeof strategyInput>,
  ): Promise<z.infer<typeof multiPlatformStrategySchema>> {
    const brand = await context.brand.load(
      context.organizationId,
      `${input.opportunityTitle} ${input.opportunityDescription}`,
    );

    const result = await context.ai.generateStructured({
      schemaName: 'multi_platform_strategy',
      schema: multiPlatformStrategySchema,
      tier: this.definition.modelTier,
      instructions: [
        'Produce one distinct strategy per requested platform.',
        '',
        'The platforms behave differently and the strategies must reflect that:',
        '- X: conversational and fast. A single post, or a thread when the idea genuinely needs',
        '  sequencing. Hooks carry the post.',
        '- Instagram: visual first. A reel concept, a carousel structure, or a single image with a',
        '  caption that works without the image.',
        '- LinkedIn: professional point of view. Insight and reasoning, not hype.',
        '',
        'Never reuse the same angle or hook across platforms. If an angle only works on one',
        'platform, give the others a genuinely different angle on the same opportunity.',
        '',
        `Recommend posting windows in the organization timezone (${brand.timezone}).`,
        '',
        FACTUALITY_RULES,
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: JSON.stringify({
        opportunity: { title: input.opportunityTitle, description: input.opportunityDescription },
        platforms: input.platforms,
        audience: input.audienceName,
      }),
      maxOutputTokens: 6_000,
    });

    return result.data;
  }
}

// ---------------------------------------------------------------------------
// ContentCreationAgent
// ---------------------------------------------------------------------------

const creationInput = z.object({
  contentType: z.enum([
    'X_POST',
    'X_THREAD',
    'INSTAGRAM_CAPTION',
    'INSTAGRAM_REEL',
    'INSTAGRAM_CAROUSEL',
    'LINKEDIN_POST',
    'LINKEDIN_ARTICLE',
    'REDDIT_POST',
    'DISCORD_POST',
  ]),
  strategy: contentStrategySchema.partial().optional(),
  brief: z.string(),
  organizationRequiresApprovalAlways: z.boolean().default(false),
});

const creationOutput = contentGenerationSchema.extend({
  /** Server-side verdicts. These override whatever the model claimed. */
  verifiedClaims: z.array(
    z.object({
      claim: z.string(),
      supportedByKnowledgeBase: z.boolean(),
      sourceReference: z.string().nullable(),
      verified: z.boolean(),
      matchedApprovedClaimId: z.string().nullable(),
    }),
  ),
  approvalReasons: z.array(z.string()),
  platformViolations: z.array(z.object({ field: z.string(), code: z.string(), message: z.string() })),
});

export class ContentCreationAgent extends Agent<typeof creationInput, typeof creationOutput> {
  readonly definition: AgentDefinition<typeof creationInput, typeof creationOutput> = {
    name: 'ContentCreationAgent',
    description:
      'Writes platform-native copy grounded in brand knowledge, then re-verifies its claims, ' +
      'platform constraints, and approval requirements server-side.',
    inputSchema: creationInput,
    outputSchema: creationOutput,
    modelTier: 'default',
    timeoutMs: 120_000,
    maxRetries: 2,
    toolNames: [],
    usesWebSearch: false,
  };

  protected async execute(
    context: AgentContext,
    input: z.infer<typeof creationInput>,
  ): Promise<z.infer<typeof creationOutput>> {
    const capability = getCapability(input.contentType);
    const brand = await context.brand.load(context.organizationId, input.brief);

    const generated = await context.ai.generateStructured({
      schemaName: 'content_generation',
      schema: contentGenerationSchema,
      tier: this.definition.modelTier,
      instructions: [
        `Write ${input.contentType} copy.`,
        '',
        'PLATFORM CONSTRAINTS - the copy must satisfy these:',
        `- Body limit: ${capability.maxCharacters.value} characters` +
          (input.contentType === 'X_THREAD' ? ' per individual post in the thread.' : '.'),
        `- Hashtags: at most ${capability.maxHashtags.value}.`,
        input.contentType === 'X_THREAD'
          ? '- Populate threadParts with each post in order, and put the first post in body too.'
          : '- Leave threadParts empty.',
        '',
        'Write in the brand voice. No filler, no throat-clearing, no "In today\'s fast-paced world".',
        'Open with the hook. Earn every sentence.',
        '',
        FACTUALITY_RULES,
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: JSON.stringify({
        brief: input.brief,
        strategy: input.strategy ?? null,
      }),
      maxOutputTokens: 4_000,
    });

    const draft = generated.data;
    const fullText = [draft.body, ...draft.threadParts, draft.cta].join('\n');

    // Server-side verification. The model's self-report is an input, not a verdict.
    const verifiedClaims = verifyClaims(draft.factualClaims, brand.approvedClaims);
    const forbiddenMatches = findForbiddenPhrases(fullText, brand.forbiddenClaims);

    const assessment = assessApproval({
      text: fullText,
      modelRiskLevel: draft.riskLevel,
      modelFlaggedTopics: draft.flaggedTopics,
      modelRequiresApproval: draft.requiresApproval,
      claims: verifiedClaims,
      forbiddenMatches,
      organizationRequiresApprovalAlways: input.organizationRequiresApprovalAlways,
    });

    const platformViolations = validateContent({
      contentType: input.contentType,
      body: draft.body,
      hashtags: draft.hashtags,
      ...(draft.threadParts.length > 0 ? { threadParts: draft.threadParts } : {}),
    });

    return {
      ...draft,
      requiresApproval: assessment.requiresApproval,
      riskLevel: assessment.riskLevel,
      flaggedTopics: assessment.flaggedTopics,
      verifiedClaims,
      approvalReasons: assessment.reasons,
      platformViolations: platformViolations.map((violation) => ({
        field: violation.field,
        code: violation.code,
        message: violation.message,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// RepurposingAgent
// ---------------------------------------------------------------------------

const repurposeInput = z.object({
  sourceBody: z.string(),
  sourceContentType: z.string(),
  targets: z
    .array(
      z.enum([
        'X_POST',
        'X_THREAD',
        'INSTAGRAM_CAPTION',
        'INSTAGRAM_REEL',
        'INSTAGRAM_CAROUSEL',
        'LINKEDIN_POST',
        'LINKEDIN_ARTICLE',
      ]),
    )
    .min(1),
});

export class RepurposingAgent extends Agent<typeof repurposeInput, typeof repurposeSchema> {
  readonly definition: AgentDefinition<typeof repurposeInput, typeof repurposeSchema> = {
    name: 'RepurposingAgent',
    description: 'Adapts one piece of content into genuinely platform-native versions for others.',
    inputSchema: repurposeInput,
    outputSchema: repurposeSchema,
    modelTier: 'default',
    timeoutMs: 150_000,
    maxRetries: 2,
    toolNames: [],
    usesWebSearch: false,
  };

  protected async execute(
    context: AgentContext,
    input: z.infer<typeof repurposeInput>,
  ): Promise<z.infer<typeof repurposeSchema>> {
    const brand = await context.brand.load(context.organizationId, input.sourceBody.slice(0, 500));

    const constraints = input.targets
      .map((target) => {
        const capability = getCapability(target);
        return `- ${target}: max ${capability.maxCharacters.value} characters, max ${capability.maxHashtags.value} hashtags.`;
      })
      .join('\n');

    const result = await context.ai.generateStructured({
      schemaName: 'repurpose',
      schema: repurposeSchema,
      tier: this.definition.modelTier,
      instructions: [
        'Adapt the source content for each requested target format.',
        '',
        'Rewrite for the destination; do not copy the source with the length trimmed. Each output',
        'must read as though it were written for that platform first. Identical copy across two',
        'platforms is a failure.',
        '',
        'CONSTRAINTS:',
        constraints,
        '',
        FACTUALITY_RULES,
        'Introduce no fact that is absent from the source content or the brand knowledge below.',
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: JSON.stringify({
        sourceContentType: input.sourceContentType,
        sourceBody: input.sourceBody,
        targets: input.targets,
      }),
      maxOutputTokens: 8_000,
    });

    return result.data;
  }
}

// ---------------------------------------------------------------------------
// Editing operations used by the content studio
// ---------------------------------------------------------------------------

export type RewriteOperation =
  | 'REWRITE'
  | 'SHORTEN'
  | 'EXPAND'
  | 'CHANGE_TONE'
  | 'GENERATE_CTA';

const REWRITE_INSTRUCTIONS: Record<RewriteOperation, string> = {
  REWRITE: 'Rewrite the copy, keeping its meaning and every factual claim unchanged.',
  SHORTEN: 'Tighten the copy substantially without losing the hook, the point, or the CTA.',
  EXPAND: 'Develop the copy with more substance. Add no new factual claims.',
  CHANGE_TONE: 'Rewrite in the requested tone while preserving meaning and factual claims.',
  GENERATE_CTA: 'Keep the body and produce a stronger, more specific call to action.',
};

/** Edit operations from the content studio. Shares the creation agent's safety pass. */
export class ContentEditor {
  constructor(private readonly context: AgentContext) {}

  async rewrite(input: {
    contentType: Parameters<typeof getCapability>[0];
    body: string;
    threadParts: string[];
    hashtags: string[];
    cta: string | null;
    operation: RewriteOperation;
    tone?: string;
    organizationRequiresApprovalAlways: boolean;
  }): Promise<z.infer<typeof contentRewriteSchema> & { approvalReasons: string[]; requiresApproval: boolean }> {
    const capability = getCapability(input.contentType);
    const brand = await this.context.brand.load(this.context.organizationId, input.body.slice(0, 500));

    const result = await this.context.ai.generateStructured({
      schemaName: 'content_rewrite',
      schema: contentRewriteSchema,
      tier: 'default',
      instructions: [
        REWRITE_INSTRUCTIONS[input.operation],
        input.tone ? `Target tone: ${input.tone}.` : '',
        '',
        `Body limit: ${capability.maxCharacters.value} characters. Hashtag limit: ${capability.maxHashtags.value}.`,
        '',
        FACTUALITY_RULES,
        '',
        renderBrandContext(brand),
      ]
        .filter(Boolean)
        .join('\n'),
      input: JSON.stringify({
        body: input.body,
        threadParts: input.threadParts,
        hashtags: input.hashtags,
        cta: input.cta,
      }),
      maxOutputTokens: 4_000,
    });

    const draft = result.data;
    const fullText = [draft.body, ...draft.threadParts, draft.cta].join('\n');
    const verified = verifyClaims(draft.factualClaims, brand.approvedClaims);
    const forbidden = findForbiddenPhrases(fullText, brand.forbiddenClaims);

    const assessment = assessApproval({
      text: fullText,
      modelRiskLevel: draft.riskLevel,
      modelFlaggedTopics: draft.flaggedTopics,
      modelRequiresApproval: true,
      claims: verified,
      forbiddenMatches: forbidden,
      organizationRequiresApprovalAlways: input.organizationRequiresApprovalAlways,
    });

    return {
      ...draft,
      riskLevel: assessment.riskLevel,
      flaggedTopics: assessment.flaggedTopics,
      requiresApproval: assessment.requiresApproval,
      approvalReasons: assessment.reasons,
    };
  }

  async generateHooks(input: { body: string; contentType: string; count: number }): Promise<
    z.infer<typeof hookVariantsSchema>
  > {
    const brand = await this.context.brand.load(this.context.organizationId, input.body.slice(0, 300));
    const result = await this.context.ai.generateStructured({
      schemaName: 'hook_variants',
      schema: hookVariantsSchema,
      tier: 'fast',
      instructions: [
        `Produce ${input.count} distinct opening hooks for this ${input.contentType}.`,
        'Vary the mechanism: a claim, a question, a contrast, a concrete number, a scene.',
        'Introduce no factual claim not already present in the copy.',
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: input.body,
      maxOutputTokens: 1_500,
    });
    return result.data;
  }

  /** Checks copy against the organization's own brand rules. */
  async brandCheck(body: string): Promise<z.infer<typeof brandCheckSchema>> {
    const brand = await this.context.brand.load(this.context.organizationId, body.slice(0, 300));
    const result = await this.context.ai.generateStructured({
      schemaName: 'brand_check',
      schema: brandCheckSchema,
      tier: 'fast',
      instructions: [
        'Check the copy against the brand guidelines, writing rules, tone, and banned phrases below.',
        'Report only genuine violations, each with the offending excerpt and a concrete fix.',
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: body,
      maxOutputTokens: 2_000,
    });
    return result.data;
  }

  /**
   * Fact-checks copy against approved claims.
   *
   * The deterministic verdict comes first, from claim matching in code; the model
   * then explains each verdict and recommends a fix. It cannot promote a claim
   * to SUPPORTED that matching rejected.
   */
  async factCheck(body: string): Promise<
    z.infer<typeof factCheckSchema> & { unverifiedCount: number }
  > {
    const brand = await this.context.brand.load(this.context.organizationId, body.slice(0, 300));

    const result = await this.context.ai.generateStructured({
      schemaName: 'fact_check',
      schema: factCheckSchema,
      tier: 'default',
      instructions: [
        'Identify every factual assertion in the copy, then judge each strictly against the',
        'APPROVED CLAIMS and RETRIEVED BRAND KNOWLEDGE below.',
        '',
        'SUPPORTED requires the approved claims to state it. Anything plausible but absent is',
        'UNSUPPORTED. Anything the knowledge contradicts is CONTRADICTED. Do not treat general',
        'world knowledge as support for a claim about this brand.',
        '',
        renderBrandContext(brand),
      ].join('\n'),
      input: body,
      maxOutputTokens: 3_000,
    });

    // Re-derive the counts in code so the summary cannot be softened by the model.
    const verified = verifyClaims(
      result.data.claims.map((claim) => ({
        claim: claim.claim,
        supportedByKnowledgeBase: claim.verdict === 'SUPPORTED',
        sourceReference: claim.evidence,
      })),
      brand.approvedClaims,
    );

    return {
      claims: result.data.claims.map((claim, index) => ({
        ...claim,
        verdict: verified[index]?.verified ? claim.verdict : claim.verdict === 'SUPPORTED' ? 'NEEDS_REVIEW' : claim.verdict,
      })),
      overallRisk: result.data.overallRisk,
      unverifiedCount: verified.filter((claim) => !claim.verified).length,
    };
  }
}
