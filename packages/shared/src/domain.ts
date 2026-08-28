/**
 * Domain vocabulary shared by API, worker, and web.
 *
 * These string unions mirror the Prisma enums exactly. Keeping them here as
 * plain constants means the web app can import the vocabulary without pulling
 * in the Prisma client.
 */

export const CONTENT_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'CANCELLED',
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Transitions the API will accept. Anything absent here is rejected as a conflict. */
export const CONTENT_STATUS_TRANSITIONS: Readonly<Record<ContentStatus, readonly ContentStatus[]>> =
  Object.freeze({
    DRAFT: ['PENDING_APPROVAL', 'APPROVED', 'CANCELLED'],
    PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'DRAFT', 'CANCELLED'],
    APPROVED: ['SCHEDULED', 'PUBLISHING', 'DRAFT', 'CANCELLED'],
    REJECTED: ['DRAFT', 'CANCELLED'],
    SCHEDULED: ['PUBLISHING', 'APPROVED', 'CANCELLED'],
    // PUBLISHING is owned by the worker; it may only settle.
    PUBLISHING: ['PUBLISHED', 'FAILED'],
    // Terminal.
    PUBLISHED: [],
    FAILED: ['DRAFT', 'APPROVED', 'SCHEDULED', 'CANCELLED'],
    CANCELLED: ['DRAFT'],
  });

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  return CONTENT_STATUS_TRANSITIONS[from].includes(to);
}

export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const AUTOMATION_MODES = ['MANUAL', 'COPILOT', 'AUTOPILOT'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const OPPORTUNITY_STATUSES = [
  'NEW',
  'REVIEWED',
  'SELECTED',
  'CONVERTED',
  'DISMISSED',
  'EXPIRED',
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_TEMPLATES = [
  'PRODUCT_LAUNCH',
  'FEATURE_LAUNCH',
  'COMMUNITY_GROWTH',
  'GAME_LAUNCH',
  'EDUCATIONAL',
  'THOUGHT_LEADERSHIP',
  'ENGAGEMENT',
  'EVENT',
  'PARTNERSHIP',
] as const;
export type CampaignTemplate = (typeof CAMPAIGN_TEMPLATES)[number];

export const MARKETING_GOALS = [
  'AWARENESS',
  'COMMUNITY_GROWTH',
  'USER_ACQUISITION',
  'GAME_CREATORS',
  'SPORTS_PREDICTION_USERS',
  'WEB3_USERS',
  'DEVELOPER_ADOPTION',
  'PARTNERSHIPS',
  'RETENTION',
] as const;
export type MarketingGoal = (typeof MARKETING_GOALS)[number];

export const RESEARCH_SOURCE_TYPES = [
  'WEB',
  'RSS',
  'REDDIT',
  'X',
  'YOUTUBE',
  'GOOGLE_TRENDS',
  'NEWS',
  'CUSTOM_URL',
] as const;
export type ResearchSourceType = (typeof RESEARCH_SOURCE_TYPES)[number];

export const CONNECTION_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'REVOKED',
  'ERROR',
  'DISCONNECTED',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const PUBLICATION_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const AGENT_NAMES = [
  'TrendResearchAgent',
  'NicheDiscoveryAgent',
  'CompetitorResearchAgent',
  'OpportunityAgent',
  'ContentStrategyAgent',
  'ContentCreationAgent',
  'RepurposingAgent',
  'CampaignAgent',
  'AnalyticsAgent',
  'OptimizationAgent',
  'MarketingCopilotAgent',
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENT_EXECUTION_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type AgentExecutionStatus = (typeof AGENT_EXECUTION_STATUSES)[number];

export const WORKFLOW_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const STRATEGY_INSIGHT_STATUSES = ['PROPOSED', 'ACCEPTED', 'REJECTED'] as const;
export type StrategyInsightStatus = (typeof STRATEGY_INSIGHT_STATUSES)[number];

export const QUEUE_NAMES = {
  research: 'research',
  ai: 'ai',
  content: 'content',
  publishing: 'publishing',
  analytics: 'analytics',
  notifications: 'notifications',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Topics that force human approval regardless of automation mode.
 * Mirrors the "Require approval for" list in the product specification.
 */
export const MANDATORY_APPROVAL_TOPICS = [
  'TOKEN_CLAIM',
  'FINANCIAL_CLAIM',
  'PARTNERSHIP',
  'COMPETITOR_ACCUSATION',
  'SENSITIVE_NEWS',
  'POLITICAL',
  'CONTROVERSIAL',
  'REGULATORY',
  'UNVERIFIED_STATISTIC',
] as const;
export type MandatoryApprovalTopic = (typeof MANDATORY_APPROVAL_TOPICS)[number];

/** Alias matching the Prisma `ApprovalTopic` enum name. */
export type ApprovalTopic = MandatoryApprovalTopic;

/**
 * Autopilot may only ever publish content that clears every one of these.
 * Evaluated server-side in the publishing worker, never in the browser.
 */
export interface AutopilotEligibility {
  eligible: boolean;
  blockers: string[];
}

export function evaluateAutopilotEligibility(input: {
  automationMode: AutomationMode;
  riskLevel: RiskLevel;
  flaggedTopics: MandatoryApprovalTopic[];
  allowedContentTypes: string[];
  contentType: string;
  hasUnverifiedClaims: boolean;
  connectionStatus: ConnectionStatus;
  publishedInLast24h: number;
  dailyLimit: number;
}): AutopilotEligibility {
  const blockers: string[] = [];

  if (input.automationMode !== 'AUTOPILOT') {
    blockers.push(`Organization automation mode is ${input.automationMode}, not AUTOPILOT.`);
  }
  if (input.riskLevel !== 'LOW') {
    blockers.push(`Content risk level is ${input.riskLevel}; autopilot only publishes LOW risk content.`);
  }
  if (input.flaggedTopics.length > 0) {
    blockers.push(`Content is flagged for mandatory review: ${input.flaggedTopics.join(', ')}.`);
  }
  if (!input.allowedContentTypes.includes(input.contentType)) {
    blockers.push(`${input.contentType} is not in the organization's autopilot content type allowlist.`);
  }
  if (input.hasUnverifiedClaims) {
    blockers.push('Content contains factual claims that are not backed by an approved claim.');
  }
  if (input.connectionStatus !== 'ACTIVE') {
    blockers.push(`Social connection status is ${input.connectionStatus}.`);
  }
  if (input.publishedInLast24h >= input.dailyLimit) {
    blockers.push(
      `Autopilot daily publishing limit reached (${input.publishedInLast24h}/${input.dailyLimit}).`,
    );
  }

  return { eligible: blockers.length === 0, blockers };
}
