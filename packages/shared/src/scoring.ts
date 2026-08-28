/**
 * Deterministic scoring.
 *
 * Scores are computed here, in plain arithmetic, from measured signals. The AI
 * is never asked to invent a score - it is asked to *explain* one that this
 * module already produced. Every component is persisted alongside the total so
 * a score can be recomputed and audited after the fact.
 *
 * All component inputs and outputs are on a 0-100 scale.
 */

export const clamp = (value: number, min = 0, max = 100): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const round = (value: number): number => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// Trend scoring
// ---------------------------------------------------------------------------

export interface TrendScoreComponents {
  /** Rate of new mentions per unit time, normalised against the corpus. */
  velocity: number;
  /** Change in velocity between the previous and current window. */
  growth: number;
  /** Normalised engagement (likes/comments/shares) on source items. */
  engagement: number;
  /** How recent the supporting evidence is. */
  recency: number;
  /** Semantic proximity to the organization's brand profile and products. */
  relevance: number;
  /** Overlap between the trend's audience and the organization's audiences. */
  audienceOverlap: number;
  /** How crowded the topic already is with competitor content. */
  competition: number;
  /** How much near-identical content already exists. */
  saturation: number;
  /** Brand-safety / controversy risk. */
  risk: number;
}

export const TREND_WEIGHTS = {
  velocity: 0.2,
  growth: 0.15,
  engagement: 0.12,
  recency: 0.08,
  relevance: 0.25,
  audienceOverlap: 0.1,
  // Negative contributions.
  saturation: 0.15,
  risk: 0.15,
  competition: 0.1,
} as const;

export interface ScoreResult<C> {
  score: number;
  components: C;
  /** Signed contribution of each component to the final score, for explainability. */
  contributions: Record<keyof C & string, number>;
}

export function scoreTrend(raw: TrendScoreComponents): ScoreResult<TrendScoreComponents> {
  const c: TrendScoreComponents = {
    velocity: clamp(raw.velocity),
    growth: clamp(raw.growth),
    engagement: clamp(raw.engagement),
    recency: clamp(raw.recency),
    relevance: clamp(raw.relevance),
    audienceOverlap: clamp(raw.audienceOverlap),
    competition: clamp(raw.competition),
    saturation: clamp(raw.saturation),
    risk: clamp(raw.risk),
  };

  const contributions = {
    velocity: c.velocity * TREND_WEIGHTS.velocity,
    growth: c.growth * TREND_WEIGHTS.growth,
    engagement: c.engagement * TREND_WEIGHTS.engagement,
    recency: c.recency * TREND_WEIGHTS.recency,
    relevance: c.relevance * TREND_WEIGHTS.relevance,
    audienceOverlap: c.audienceOverlap * TREND_WEIGHTS.audienceOverlap,
    saturation: -(c.saturation * TREND_WEIGHTS.saturation),
    risk: -(c.risk * TREND_WEIGHTS.risk),
    competition: -(c.competition * TREND_WEIGHTS.competition),
  };

  const total = Object.values(contributions).reduce((sum, value) => sum + value, 0);

  // Positive weights sum to 0.90, so a perfect positive profile yields 90 before
  // penalties. Normalise back onto 0-100 so the number reads as a percentage.
  const positiveWeightSum =
    TREND_WEIGHTS.velocity +
    TREND_WEIGHTS.growth +
    TREND_WEIGHTS.engagement +
    TREND_WEIGHTS.recency +
    TREND_WEIGHTS.relevance +
    TREND_WEIGHTS.audienceOverlap;

  return {
    score: round(clamp((total / positiveWeightSum) * 1)),
    components: c,
    contributions: Object.fromEntries(
      Object.entries(contributions).map(([key, value]) => [key, round(value)]),
    ) as Record<keyof TrendScoreComponents & string, number>,
  };
}

// ---------------------------------------------------------------------------
// Niche scoring
// ---------------------------------------------------------------------------

export interface NicheScoreComponents {
  relevance: number;
  trendVelocity: number;
  growthSignal: number;
  audienceFit: number;
  competition: number;
}

export const NICHE_WEIGHTS = {
  relevance: 0.35,
  trendVelocity: 0.2,
  growthSignal: 0.2,
  audienceFit: 0.25,
  competition: 0.25,
} as const;

export function scoreNiche(raw: NicheScoreComponents): ScoreResult<NicheScoreComponents> {
  const c: NicheScoreComponents = {
    relevance: clamp(raw.relevance),
    trendVelocity: clamp(raw.trendVelocity),
    growthSignal: clamp(raw.growthSignal),
    audienceFit: clamp(raw.audienceFit),
    competition: clamp(raw.competition),
  };

  const contributions = {
    relevance: c.relevance * NICHE_WEIGHTS.relevance,
    trendVelocity: c.trendVelocity * NICHE_WEIGHTS.trendVelocity,
    growthSignal: c.growthSignal * NICHE_WEIGHTS.growthSignal,
    audienceFit: c.audienceFit * NICHE_WEIGHTS.audienceFit,
    competition: -(c.competition * NICHE_WEIGHTS.competition),
  };

  const positiveWeightSum =
    NICHE_WEIGHTS.relevance +
    NICHE_WEIGHTS.trendVelocity +
    NICHE_WEIGHTS.growthSignal +
    NICHE_WEIGHTS.audienceFit;

  const total = Object.values(contributions).reduce((sum, value) => sum + value, 0);

  return {
    score: round(clamp((total / positiveWeightSum) * 1)),
    components: c,
    contributions: Object.fromEntries(
      Object.entries(contributions).map(([key, value]) => [key, round(value)]),
    ) as Record<keyof NicheScoreComponents & string, number>,
  };
}

// ---------------------------------------------------------------------------
// Opportunity scoring
// ---------------------------------------------------------------------------

export interface OpportunityScoreComponents {
  /** Score of the strongest supporting trend. */
  trendScore: number;
  /** Brand/product relevance of the proposed angle. */
  relevanceScore: number;
  /** How crowded the space is. Higher is worse. */
  competitionScore: number;
  /** Brand-safety risk of acting on this. Higher is worse. */
  riskScore: number;
  /** How soon the window closes. Higher means more urgent, which is better. */
  timeliness: number;
  /** Historical performance of this platform/format pairing for this org. */
  historicalFit: number;
}

export const OPPORTUNITY_WEIGHTS = {
  trendScore: 0.3,
  relevanceScore: 0.3,
  timeliness: 0.15,
  historicalFit: 0.25,
  competitionScore: 0.2,
  riskScore: 0.25,
} as const;

export function scoreOpportunity(
  raw: OpportunityScoreComponents,
): ScoreResult<OpportunityScoreComponents> {
  const c: OpportunityScoreComponents = {
    trendScore: clamp(raw.trendScore),
    relevanceScore: clamp(raw.relevanceScore),
    competitionScore: clamp(raw.competitionScore),
    riskScore: clamp(raw.riskScore),
    timeliness: clamp(raw.timeliness),
    historicalFit: clamp(raw.historicalFit),
  };

  const contributions = {
    trendScore: c.trendScore * OPPORTUNITY_WEIGHTS.trendScore,
    relevanceScore: c.relevanceScore * OPPORTUNITY_WEIGHTS.relevanceScore,
    timeliness: c.timeliness * OPPORTUNITY_WEIGHTS.timeliness,
    historicalFit: c.historicalFit * OPPORTUNITY_WEIGHTS.historicalFit,
    competitionScore: -(c.competitionScore * OPPORTUNITY_WEIGHTS.competitionScore),
    riskScore: -(c.riskScore * OPPORTUNITY_WEIGHTS.riskScore),
  };

  const positiveWeightSum =
    OPPORTUNITY_WEIGHTS.trendScore +
    OPPORTUNITY_WEIGHTS.relevanceScore +
    OPPORTUNITY_WEIGHTS.timeliness +
    OPPORTUNITY_WEIGHTS.historicalFit;

  const total = Object.values(contributions).reduce((sum, value) => sum + value, 0);

  return {
    score: round(clamp((total / positiveWeightSum) * 1)),
    components: c,
    contributions: Object.fromEntries(
      Object.entries(contributions).map(([key, value]) => [key, round(value)]),
    ) as Record<keyof OpportunityScoreComponents & string, number>,
  };
}

// ---------------------------------------------------------------------------
// Signal normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Maps an unbounded count onto 0-100 with diminishing returns, so a handful of
 * viral outliers cannot dominate a corpus. `midpoint` is the value that maps to 50.
 */
export function saturating(value: number, midpoint: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (midpoint <= 0) return 0;
  return clamp((value / (value + midpoint)) * 100);
}

/** Exponential recency decay. `halfLifeHours` is the age at which the score halves. */
export function recencyScore(publishedAt: Date, now: Date, halfLifeHours = 48): number {
  const ageHours = (now.getTime() - publishedAt.getTime()) / 3_600_000;
  if (ageHours <= 0) return 100;
  return clamp(100 * Math.pow(0.5, ageHours / halfLifeHours));
}

/**
 * Velocity as items per hour over the observation window, normalised so that
 * `expectedPerHour` maps to 50.
 */
export function velocityScore(itemCount: number, windowHours: number, expectedPerHour = 1): number {
  if (windowHours <= 0) return 0;
  return saturating(itemCount / windowHours, expectedPerHour);
}

/**
 * Growth as the change between two consecutive windows. A doubling maps to ~75,
 * flat maps to 50, and a collapse to zero maps to 0.
 */
export function growthScore(currentCount: number, previousCount: number): number {
  if (previousCount <= 0) return currentCount > 0 ? 100 : 0;
  const ratio = currentCount / previousCount;
  // ratio 1 -> 50, ratio 2 -> ~75, ratio 0.5 -> ~25
  return clamp(50 * Math.log2(ratio) + 50);
}

/** Cosine similarity mapped from [-1, 1] onto [0, 100]. */
export function similarityToScore(cosine: number): number {
  if (!Number.isFinite(cosine)) return 0;
  return clamp(((cosine + 1) / 2) * 100);
}
