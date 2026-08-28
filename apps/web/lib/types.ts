/**
 * API response shapes.
 *
 * The vocabulary (statuses, roles, content types) is imported from @kult/shared
 * so the frontend and backend cannot drift on an enum value. Response shapes are
 * declared here rather than generated, and are kept deliberately narrow: a page
 * declares what it reads, so an API change that removes a field surfaces as a
 * type error instead of `undefined` on screen.
 */

import type {
  AutomationMode,
  CampaignStatus,
  ContentStatus,
  ContentType,
  OpportunityStatus,
  OrganizationRole,
  Permission,
  ResearchSourceType,
  RiskLevel,
  SocialProvider,
} from '@kult/shared';

export type {
  AutomationMode,
  CampaignStatus,
  ContentStatus,
  ContentType,
  OpportunityStatus,
  OrganizationRole,
  Permission,
  ResearchSourceType,
  RiskLevel,
  SocialProvider,
};

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MeResponse {
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    walletAddress: string | null;
  };
  organizations: Array<{ id: string; name: string; slug: string; role: OrganizationRole }>;
  needsOrganization: boolean;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  websiteUrl: string | null;
  timezone: string;
  automationMode: AutomationMode;
  autopilotContentTypes: ContentType[];
  autopilotEnabledAt: string | null;
  primaryGoals: string[];
  onboardingStep: number;
  onboardingCompletedAt: string | null;
  memberCount: number;
  yourRole: OrganizationRole;
  yourPermissions: Permission[];
  createdAt: string;
}

export interface Member {
  id: string;
  role: OrganizationRole;
  createdAt: string;
  user: { id: string; email: string | null; displayName: string | null; avatarUrl: string | null };
}

export interface Trend {
  id: string;
  name: string;
  slug: string;
  summary: string;
  rationale: string | null;
  score: number;
  components: Record<string, number>;
  contributions: Record<string, number>;
  status: 'EMERGING' | 'ACTIVE' | 'DECLINING' | 'EXPIRED';
  keywords: string[];
  firstDetectedAt: string;
  lastSeenAt: string;
  _count?: { signals: number };
}

export interface TrendEvidence {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  sourceType: string;
  engagement: Record<string, number>;
  weight: number;
  observedAt: string;
}

export interface TrendDetail extends Trend {
  expiresAt: string | null;
  evidence: TrendEvidence[];
}

export interface Niche {
  id: string;
  name: string;
  description: string;
  rationale: string | null;
  score: number;
  components: Record<string, number>;
  contributions: Record<string, number>;
  parentNicheId: string | null;
  audience: { id: string; name: string } | null;
  createdAt: string;
}

export interface Opportunity {
  id: string;
  title: string;
  description: string;
  platform: SocialProvider | null;
  contentFormat: ContentType | null;
  marketingObjective: string | null;
  recommendedAction: string | null;
  relevanceScore: number;
  trendScore: number;
  competitionScore: number;
  riskScore: number;
  opportunityScore: number;
  status: OpportunityStatus;
  expiresAt: string | null;
  createdAt: string;
}

export interface OpportunityDetail extends Opportunity {
  rationale: string | null;
  components: Record<string, number>;
  contributions: Record<string, number>;
  trends: Array<{ trend: { id: string; name: string; slug: string; score: number; summary: string } }>;
  niches: Array<{ niche: { id: string; name: string; score: number } }>;
}

export interface ResearchItem {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  collectedAt: string;
  sourceType: string;
  engagement: Record<string, number>;
  keywords: string[];
  sentiment: number | null;
  topic: string | null;
}

export interface ResearchSource {
  id: string;
  type: ResearchSourceType;
  name: string;
  config: Record<string, unknown>;
  status: 'ACTIVE' | 'DISABLED' | 'ERROR' | 'UNAVAILABLE';
  unavailableReason: string | null;
  lastRunAt: string | null;
  lastItemCount: number;
  createdAt: string;
}

export interface SourceTypeAvailability {
  type: ResearchSourceType;
  available: boolean;
  reason?: string;
  requiredVariables?: string[];
}

export interface ContentItem {
  id: string;
  contentType: ContentType;
  platform: SocialProvider | null;
  title: string | null;
  body: string;
  status: ContentStatus;
  riskLevel: RiskLevel;
  flaggedTopics: string[];
  requiresApproval: boolean;
  scheduledAt: string | null;
  publishedAt: string | null;
  version: number;
  campaignId: string | null;
  opportunityId: string | null;
  createdByAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactualClaim {
  claim: string;
  supportedByKnowledgeBase: boolean;
  sourceReference: string | null;
  verified: boolean;
  matchedApprovedClaimId: string | null;
}

export interface ContentItemDetail extends ContentItem {
  threadParts: string[];
  hashtags: string[];
  mentions: string[];
  cta: string | null;
  factualClaims: FactualClaim[];
  createdBy: { id: string; displayName: string | null; email: string | null } | null;
  mediaAssets: Array<{
    order: number;
    brandAsset: {
      id: string;
      name: string;
      mimeType: string;
      publicUrl: string | null;
      width: number | null;
      height: number | null;
    };
  }>;
  approvals: Array<{
    id: string;
    decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
    comment: string | null;
    createdAt: string;
    reviewer: { id: string; displayName: string | null; email: string | null };
  }>;
  publications: Array<{
    id: string;
    provider: SocialProvider;
    status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
    providerPostId: string | null;
    providerUrl: string | null;
    publishedAt: string | null;
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
}

export interface ContentVersion {
  id: string;
  version: number;
  body: string;
  threadParts: string[];
  hashtags: string[];
  cta: string | null;
  rationale: string | null;
  changeSummary: string | null;
  createdByAgent: string | null;
  createdAt: string;
  createdBy: { id: string; displayName: string | null; email: string | null } | null;
}

export interface Campaign {
  id: string;
  name: string;
  objective: string;
  template: string | null;
  startDate: string;
  endDate: string;
  platforms: SocialProvider[];
  budgetAmount: string | null;
  budgetCurrency: string | null;
  status: CampaignStatus;
  activatedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  _count: { contentItems: number };
}

export interface CampaignDetail extends Campaign {
  strategy: {
    summary?: string;
    audience?: string;
    contentPillars?: Array<{ name: string; description: string }>;
    platformAllocation?: Array<{ platform: string; postCount: number; rationale: string }>;
    successMetrics?: string[];
    risks?: string[];
  };
  approvalMode: AutomationMode;
  audience: { id: string; name: string } | null;
  createdBy: { id: string; displayName: string | null; email: string | null } | null;
  steps: Array<{
    id: string;
    order: number;
    title: string;
    description: string | null;
    dueAt: string | null;
    completedAt: string | null;
  }>;
  contentItems: Array<{
    id: string;
    contentType: ContentType;
    title: string | null;
    status: ContentStatus;
    scheduledAt: string | null;
    publishedAt: string | null;
  }>;
}

export interface ConnectionCapabilities {
  publishableContentTypes: ContentType[];
  unavailable: Record<string, string>;
  grantedScopes: string[];
  missingScopes: string[];
  canReadMetrics: boolean;
}

export interface SocialConnection {
  id: string;
  provider: SocialProvider;
  providerAccountId: string;
  accountName: string;
  accountUsername: string | null;
  scopes: string[];
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'ERROR' | 'DISCONNECTED';
  expiresAt: string | null;
  metadata: Record<string, unknown>;
  capabilities: ConnectionCapabilities;
  lastValidatedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  tokenExpired: boolean;
}

export interface IntegrationProvider {
  provider: SocialProvider;
  configured: boolean;
  requestedScopes: string[];
  configurationRequirement?: { message: string; requiredVariables: string[] };
  connections: SocialConnection[];
}

export interface AnalyticsOverview {
  periodDays: number;
  since: string;
  totals: {
    posts: number;
    impressions: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    reposts: number | null;
    saves: number | null;
    clicks: number | null;
    videoViews: number | null;
  };
  byProvider: Array<{ provider: string; posts: number; impressions: number | null }>;
  contentByStatus: Record<string, number>;
  metricGaps: Array<{ provider: string; reason: string }>;
  measuredPosts: number;
}

export interface PostAnalytics {
  id: string;
  provider: SocialProvider;
  providerPostId: string | null;
  providerUrl: string | null;
  publishedAt: string | null;
  contentItem: {
    id: string;
    title: string | null;
    contentType: ContentType;
    body: string;
    hashtags: string[];
  };
  latestMetrics: {
    impressions: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    reposts: number | null;
    saves: number | null;
    clicks: number | null;
    videoViews: number | null;
    engagementRate: number | null;
    capturedAt: string;
  } | null;
  metricsAvailable: boolean;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  modelTier: string;
  timeoutMs: number;
  maxRetries: number;
  toolNames: string[];
  enabled: boolean;
}

export interface AgentExecution {
  id: string;
  agentName: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  model: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  correlationId: string | null;
  workflowExecutionId: string | null;
  triggeredBy: { id: string; displayName: string | null } | null;
  triggeredByType: 'USER' | 'AGENT' | 'SYSTEM';
  _count: { toolCalls: number };
}

export interface StrategyInsight {
  id: string;
  type: string;
  evidence: Record<string, unknown>;
  confidence: number;
  recommendation: string;
  supportingContentIds: string[];
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED';
  decidedAt: string | null;
  createdAt: string;
  decidedBy: { id: string; displayName: string | null } | null;
}

export interface KnowledgeOverview {
  profile: {
    id: string;
    description: string;
    positioning: string | null;
    mission: string | null;
    voiceSummary: string | null;
    toneAttributes: string[];
    writingRules: string[];
    bannedPhrases: string[];
  } | null;
  products: Array<{ id: string; name: string; description: string; url: string | null }>;
  features: Array<{ id: string; name: string; description: string }>;
  audiences: Array<{ id: string; name: string; description: string; painPoints: string[] }>;
  competitors: Array<{ id: string; name: string; websiteUrl: string | null; notes: string | null }>;
  approvedClaims: Array<{ id: string; claim: string; evidenceUrl: string | null; expiresAt: string | null }>;
  forbiddenClaims: Array<{ id: string; claim: string; reason: string }>;
  guidelines: Array<{ id: string; category: string; rule: string; severity: RiskLevel }>;
  documents: Array<{
    id: string;
    title: string;
    sourceType: string;
    sourceUrl: string | null;
    status: 'PENDING' | 'PROCESSING' | 'INDEXED' | 'FAILED';
    chunkCount: number;
    extractedChars: number;
    error: string | null;
    createdAt: string;
  }>;
  indexedChunks: number;
}

export interface DashboardData {
  opportunities: { top: Opportunity[]; openCount: number };
  trends: Array<Pick<Trend, 'id' | 'name' | 'score' | 'summary' | 'status' | 'lastSeenAt'>>;
  upcomingContent: Array<{
    id: string;
    title: string | null;
    contentType: ContentType;
    scheduledAt: string | null;
    status: ContentStatus;
    campaign: { id: string; name: string } | null;
  }>;
  needsApproval: Array<{
    id: string;
    title: string | null;
    contentType: ContentType;
    riskLevel: RiskLevel;
    flaggedTopics: string[];
    createdAt: string;
  }>;
  publishing: {
    recent: Array<{
      id: string;
      provider: SocialProvider;
      providerUrl: string | null;
      publishedAt: string | null;
      contentItem: { id: string; title: string | null; contentType: ContentType };
      latestMetrics: {
        impressions: number | null;
        likes: number | null;
        comments: number | null;
        engagementRate: number | null;
      } | null;
    }>;
    failedCount: number;
  };
  connections: Array<{
    id: string;
    provider: SocialProvider;
    accountName: string;
    status: string;
    expiresAt: string | null;
    lastValidatedAt: string | null;
    lastErrorMessage: string | null;
    tokenExpired: boolean;
  }>;
  agentActivity: Array<{
    id: string;
    agentName: string;
    status: string;
    startedAt: string;
    latencyMs: number | null;
    output: unknown;
  }>;
  proposedInsights: Array<{ id: string; type: string; recommendation: string; confidence: number }>;
}

export interface Notification {
  id: string;
  type: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  title: string;
  body: string | null;
  resourceType: string | null;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface CopilotThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  _count?: { messages: number };
}

export interface CopilotMessage {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  content: string;
  toolCalls: Array<{ name: string; status: string; latencyMs: number }>;
  createdAt: string;
}

export interface CopilotThreadDetail extends CopilotThread {
  messages: CopilotMessage[];
}

export interface CopilotReply {
  message: { id: string; content: string; createdAt: string };
  toolCalls: Array<{ name: string; status: string; message?: string }>;
  pendingConfirmations: Array<{
    actionId: string;
    summary: string;
    details: Record<string, unknown>;
  }>;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface WorkflowExecution {
  id: string;
  workflowName: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  steps: Array<{ name: string; status: string; error?: string; summary?: Record<string, unknown> }>;
  currentStep: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  output: unknown;
}
