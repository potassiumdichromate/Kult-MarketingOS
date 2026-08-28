import { z } from 'zod';

/**
 * Job payload contracts.
 *
 * These mirror exactly what the API enqueues. Every processor parses its payload
 * through the schema here rather than trusting the job data, so a malformed or
 * stale job (for example one enqueued by an older deployment) fails fast with a
 * clear validation error instead of throwing deep inside a provider call.
 */

const base = {
  organizationId: z.string().min(1),
  correlationId: z.string().min(1),
};

export const publishContentJob = z.object({
  ...base,
  contentItemId: z.string().min(1),
  socialConnectionId: z.string().min(1),
  contentVersion: z.number().int().positive(),
  /** Absent when autopilot enqueued the job rather than a person. */
  actorUserId: z.string().min(1).optional(),
});
export type PublishContentJob = z.infer<typeof publishContentJob>;

export const runResearchJob = z.object({
  ...base,
  workflowExecutionId: z.string().min(1),
  sourceIds: z.array(z.string().min(1)),
  triggeredByUserId: z.string().min(1).optional(),
});
export type RunResearchJob = z.infer<typeof runResearchJob>;

export const discoverNichesJob = z.object({
  ...base,
  workflowExecutionId: z.string().min(1),
  triggeredByUserId: z.string().min(1).optional(),
});
export type DiscoverNichesJob = z.infer<typeof discoverNichesJob>;

export const generateOpportunitiesJob = z.object({
  ...base,
  workflowExecutionId: z.string().min(1),
  triggeredByUserId: z.string().min(1).optional(),
});
export type GenerateOpportunitiesJob = z.infer<typeof generateOpportunitiesJob>;

export const generateCampaignJob = z.object({
  ...base,
  campaignId: z.string().min(1),
  workflowExecutionId: z.string().min(1),
  postsPerWeek: z.number().int().min(1).max(30).default(5),
  opportunityIds: z.array(z.string().min(1)).default([]),
  triggeredByUserId: z.string().min(1).optional(),
});
export type GenerateCampaignJob = z.infer<typeof generateCampaignJob>;

export const generateContentJob = z.object({
  ...base,
  contentItemId: z.string().min(1),
  brief: z.string().min(1),
  triggeredByUserId: z.string().min(1).optional(),
});
export type GenerateContentJob = z.infer<typeof generateContentJob>;

export const indexDocumentJob = z.object({
  ...base,
  sourceDocumentId: z.string().min(1),
  text: z.string(),
});
export type IndexDocumentJob = z.infer<typeof indexDocumentJob>;

export const performanceReviewJob = z.object({
  ...base,
  workflowExecutionId: z.string().min(1),
  periodDays: z.number().int().min(1).max(365).default(30),
  triggeredByUserId: z.string().min(1).optional(),
});
export type PerformanceReviewJob = z.infer<typeof performanceReviewJob>;

/** Enqueued by the publishing processor after a successful publication. */
export const collectMetricsJob = z.object({
  ...base,
  publicationId: z.string().min(1),
});
export type CollectMetricsJob = z.infer<typeof collectMetricsJob>;

export const notifyJob = z.object({
  organizationId: z.string().min(1),
  userId: z.string().min(1).nullable().default(null),
  type: z.enum([
    'APPROVAL_REQUIRED',
    'PUBLISHING_SUCCEEDED',
    'PUBLISHING_FAILED',
    'OAUTH_DISCONNECTED',
    'TOKEN_EXPIRED',
    'CAMPAIGN_COMPLETED',
    'OPPORTUNITY_DISCOVERED',
    'RESEARCH_COMPLETED',
  ]),
  severity: z.enum(['INFO', 'WARNING', 'ERROR']).default('INFO'),
  title: z.string().min(1),
  body: z.string().nullable().default(null),
  resourceType: z.string().nullable().default(null),
  resourceId: z.string().nullable().default(null),
});
export type NotifyJob = z.infer<typeof notifyJob>;

/** Maintenance jobs carry no payload; they sweep every organization. */
export const maintenanceJob = z.object({}).passthrough();

export const JOB_NAMES = {
  publishContent: 'publish-content',
  runResearch: 'run-research',
  discoverNiches: 'discover-niches',
  generateOpportunities: 'generate-opportunities',
  generateCampaign: 'generate-campaign',
  generateContent: 'generate-content',
  indexDocument: 'index-document',
  performanceReview: 'performance-review',
  collectMetrics: 'collect-metrics',
  notify: 'notify',
  // Maintenance
  reconcileSchedules: 'reconcile-schedules',
  refreshTokens: 'refresh-tokens',
  expireOpportunities: 'expire-opportunities',
  purgeOAuthStates: 'purge-oauth-states',
  sweepMetrics: 'sweep-metrics',
} as const;
