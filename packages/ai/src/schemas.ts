import { z } from 'zod';

/**
 * AI output contracts.
 *
 * Every generation in this application is schema-constrained. Two conventions
 * matter here:
 *
 *  - Optional values are expressed as `.nullable()`, never `.optional()`.
 *    Structured Outputs requires every property to be present in `required`, so
 *    an omitted key is a schema violation while an explicit null is not.
 *
 *  - Scores the model produces are *descriptive inputs*, never the final number.
 *    Deterministic scoring in @kult/shared owns the arithmetic; the model
 *    supplies the qualitative signals and the explanation.
 */

export const riskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const approvalTopicSchema = z.enum([
  'TOKEN_CLAIM',
  'FINANCIAL_CLAIM',
  'PARTNERSHIP',
  'COMPETITOR_ACCUSATION',
  'SENSITIVE_NEWS',
  'POLITICAL',
  'CONTROVERSIAL',
  'REGULATORY',
  'UNVERIFIED_STATISTIC',
]);

export const contentTypeSchema = z.enum([
  'X_POST',
  'X_THREAD',
  'INSTAGRAM_CAPTION',
  'INSTAGRAM_REEL',
  'INSTAGRAM_CAROUSEL',
  'LINKEDIN_POST',
  'LINKEDIN_ARTICLE',
  'REDDIT_POST',
  'DISCORD_POST',
]);

export const platformSchema = z.enum(['X', 'INSTAGRAM', 'LINKEDIN']);

/**
 * A factual assertion the model made.
 *
 * `supportedByKnowledgeBase` is the model's own belief; it is re-verified
 * server-side against ApprovedClaim rows before anything can be published.
 */
export const factualClaimSchema = z.object({
  claim: z.string().describe('The factual assertion, quoted from the generated copy.'),
  supportedByKnowledgeBase: z
    .boolean()
    .describe('True only if this claim appears in the supplied brand knowledge.'),
  sourceReference: z
    .string()
    .nullable()
    .describe('The knowledge-base excerpt or approved claim this rests on, or null.'),
});

// ---------------------------------------------------------------------------
// Research & trends
// ---------------------------------------------------------------------------

export const researchSignalSchema = z.object({
  title: z.string(),
  url: z.string().describe('The exact source URL. Never invent or approximate a URL.'),
  summary: z.string(),
  keywords: z.array(z.string()),
  entities: z.array(z.string()),
  sentiment: z.number().min(-1).max(1).describe('-1 hostile, 0 neutral, 1 enthusiastic.'),
  topic: z.string(),
});

export const webResearchResultSchema = z.object({
  queryUsed: z.string(),
  items: z.array(researchSignalSchema),
});

/** Qualitative inputs to trend scoring. The score itself is computed in code. */
export const trendAssessmentSchema = z.object({
  name: z.string().describe('A short, specific trend name.'),
  slug: z.string().describe('lowercase-hyphenated identifier.'),
  summary: z.string(),
  keywords: z.array(z.string()),
  relevanceToBrand: z
    .number()
    .min(0)
    .max(100)
    .describe('How closely this connects to the supplied brand profile and products.'),
  audienceOverlap: z
    .number()
    .min(0)
    .max(100)
    .describe('Overlap between this trend audience and the brand target audiences.'),
  competitionLevel: z.number().min(0).max(100).describe('How crowded this topic already is.'),
  contentSaturation: z.number().min(0).max(100).describe('How much near-identical content exists.'),
  brandSafetyRisk: z.number().min(0).max(100),
  riskLevel: riskLevelSchema,
  supportingItemUrls: z
    .array(z.string())
    .describe('URLs of the supplied research items that evidence this trend.'),
});

export const trendDetectionSchema = z.object({
  trends: z.array(trendAssessmentSchema),
});

/** Written after deterministic scoring, to explain a number already computed. */
export const scoreExplanationSchema = z.object({
  rationale: z
    .string()
    .describe('Two to four sentences explaining the score using the supplied components.'),
  keyDrivers: z.array(z.string()),
  keyRisks: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Niches
// ---------------------------------------------------------------------------

export const nicheSchema = z.object({
  name: z.string(),
  description: z.string(),
  parentNicheName: z.string().nullable(),
  audienceDescription: z.string(),
  rationale: z.string().describe('Why this niche matters to this specific brand.'),
  relevance: z.number().min(0).max(100),
  trendVelocity: z.number().min(0).max(100),
  growthSignal: z.number().min(0).max(100),
  audienceFit: z.number().min(0).max(100),
  competition: z.number().min(0).max(100),
});

export const nicheDiscoverySchema = z.object({
  niches: z.array(nicheSchema),
});

// ---------------------------------------------------------------------------
// Competitors
// ---------------------------------------------------------------------------

export const competitorFindingSchema = z.object({
  competitorName: z.string(),
  observation: z.string(),
  sourceUrl: z.string().nullable(),
  contentThemes: z.array(z.string()),
  cadenceObserved: z.string().nullable(),
  gapForUs: z.string().describe('An angle this competitor is not covering.'),
});

export const competitorResearchSchema = z.object({
  findings: z.array(competitorFindingSchema),
  summary: z.string(),
});

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export const opportunitySchema = z.object({
  title: z.string(),
  description: z.string(),
  platform: platformSchema.nullable(),
  contentFormat: contentTypeSchema.nullable(),
  marketingObjective: z
    .enum([
      'AWARENESS',
      'COMMUNITY_GROWTH',
      'USER_ACQUISITION',
      'GAME_CREATORS',
      'SPORTS_PREDICTION_USERS',
      'WEB3_USERS',
      'DEVELOPER_ADOPTION',
      'PARTNERSHIPS',
      'RETENTION',
    ])
    .nullable(),
  recommendedAction: z.string(),
  rationale: z.string(),
  relevance: z.number().min(0).max(100),
  competition: z.number().min(0).max(100),
  risk: z.number().min(0).max(100),
  timeliness: z.number().min(0).max(100).describe('How quickly the window closes.'),
  sourceTrendSlugs: z.array(z.string()),
  sourceNicheNames: z.array(z.string()),
  expiresInHours: z.number().int().min(1).max(2160).nullable(),
});

export const opportunityGenerationSchema = z.object({
  opportunities: z.array(opportunitySchema),
});

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export const contentStrategySchema = z.object({
  objective: z.string(),
  audience: z.string(),
  angle: z.string(),
  hook: z.string(),
  narrative: z.string(),
  cta: z.string(),
  platform: platformSchema,
  contentFormat: contentTypeSchema,
  postingWindowRecommendation: z
    .string()
    .describe('A recommended posting window with the reasoning, in the organization timezone.'),
  riskAssessment: z.string(),
  riskLevel: riskLevelSchema,
  requiresApprovalTopics: z.array(approvalTopicSchema),
});

export const multiPlatformStrategySchema = z.object({
  strategies: z.array(contentStrategySchema),
});

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

export const contentGenerationSchema = z.object({
  platform: platformSchema,
  format: contentTypeSchema,
  title: z.string().nullable(),
  hook: z.string(),
  body: z.string().describe('The complete post copy, excluding hashtags.'),
  /** Populated for X_THREAD; empty for single-post formats. */
  threadParts: z.array(z.string()),
  cta: z.string(),
  hashtags: z.array(z.string()),
  mentions: z.array(z.string()),
  rationale: z.string().describe('Why this copy suits this platform and audience.'),
  factualClaims: z.array(factualClaimSchema),
  requiresApproval: z.boolean(),
  riskLevel: riskLevelSchema,
  flaggedTopics: z.array(approvalTopicSchema),
});

export const contentRewriteSchema = z.object({
  body: z.string(),
  threadParts: z.array(z.string()),
  hashtags: z.array(z.string()),
  cta: z.string(),
  changeSummary: z.string(),
  factualClaims: z.array(factualClaimSchema),
  riskLevel: riskLevelSchema,
  flaggedTopics: z.array(approvalTopicSchema),
});

export const hookVariantsSchema = z.object({
  hooks: z.array(z.object({ hook: z.string(), rationale: z.string() })),
});

export const repurposeSchema = z.object({
  outputs: z.array(contentGenerationSchema),
});

// ---------------------------------------------------------------------------
// Brand & safety checks
// ---------------------------------------------------------------------------

export const brandCheckSchema = z.object({
  passes: z.boolean(),
  violations: z.array(
    z.object({
      rule: z.string(),
      excerpt: z.string(),
      severity: riskLevelSchema,
      suggestion: z.string(),
    }),
  ),
  toneAssessment: z.string(),
});

export const factCheckSchema = z.object({
  claims: z.array(
    z.object({
      claim: z.string(),
      verdict: z.enum(['SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED', 'NEEDS_REVIEW']),
      evidence: z.string().nullable(),
      recommendation: z.string(),
    }),
  ),
  overallRisk: riskLevelSchema,
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const campaignCalendarEntrySchema = z.object({
  dayOffset: z.number().int().min(0).describe('Days after the campaign start date.'),
  platform: platformSchema,
  contentFormat: contentTypeSchema,
  concept: z.string(),
  hook: z.string(),
  contentPillar: z.string(),
  objective: z.string(),
});

export const campaignPlanSchema = z.object({
  name: z.string(),
  objective: z.string(),
  audience: z.string(),
  strategySummary: z.string(),
  contentPillars: z.array(z.object({ name: z.string(), description: z.string() })),
  platformAllocation: z.array(
    z.object({ platform: platformSchema, postCount: z.number().int().min(0), rationale: z.string() }),
  ),
  calendar: z.array(campaignCalendarEntrySchema),
  successMetrics: z.array(z.string()),
  risks: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Analytics & learning
// ---------------------------------------------------------------------------

export const performanceAnalysisSchema = z.object({
  summary: z.string(),
  bestHooks: z.array(z.string()),
  bestFormats: z.array(z.string()),
  bestPlatforms: z.array(z.string()),
  bestPostingWindows: z.array(z.string()),
  bestTopics: z.array(z.string()),
  bestCtas: z.array(z.string()),
  strongestNiches: z.array(z.string()),
  weakPatterns: z.array(z.string()),
  decliningTopics: z.array(z.string()),
  emergingTopics: z.array(z.string()),
  recommendations: z.array(
    z.object({
      recommendation: z.string(),
      rationale: z.string(),
      confidence: z.number().min(0).max(1),
      supportingContentIds: z.array(z.string()),
    }),
  ),
});

export const strategyInsightSchema = z.object({
  insights: z.array(
    z.object({
      type: z.string(),
      recommendation: z.string(),
      evidenceSummary: z.string(),
      confidence: z.number().min(0).max(1),
      supportingContentIds: z.array(z.string()),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Onboarding assistance
// ---------------------------------------------------------------------------

export const brandExtractionSchema = z.object({
  description: z.string(),
  positioning: z.string(),
  products: z.array(z.object({ name: z.string(), description: z.string() })),
  audiences: z.array(z.object({ name: z.string(), description: z.string() })),
  toneAttributes: z.array(z.string()),
  competitors: z.array(z.string()),
});

export type ContentGeneration = z.infer<typeof contentGenerationSchema>;
export type ContentStrategy = z.infer<typeof contentStrategySchema>;
export type TrendAssessment = z.infer<typeof trendAssessmentSchema>;
export type OpportunityDraft = z.infer<typeof opportunitySchema>;
export type CampaignPlan = z.infer<typeof campaignPlanSchema>;
export type PerformanceAnalysis = z.infer<typeof performanceAnalysisSchema>;
export type FactualClaim = z.infer<typeof factualClaimSchema>;
