'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, apiRequest, query } from './api';
import type {
  AgentExecution,
  AgentSummary,
  AnalyticsOverview,
  Campaign,
  CampaignDetail,
  ContentItem,
  ContentItemDetail,
  ContentStatus,
  ContentType,
  ContentVersion,
  CopilotReply,
  CopilotThread,
  CopilotThreadDetail,
  DashboardData,
  IntegrationProvider,
  KnowledgeOverview,
  Member,
  Niche,
  Notification,
  Opportunity,
  OpportunityDetail,
  OpportunityStatus,
  Organization,
  Page,
  PostAnalytics,
  ResearchItem,
  ResearchSource,
  SourceTypeAvailability,
  StrategyInsight,
  Trend,
  TrendDetail,
  WorkflowExecution,
} from './types';

/**
 * Data access hooks.
 *
 * One module maps every endpoint, so a route change is a single edit rather than
 * a hunt through components. Mutations invalidate the query keys their write
 * actually affects instead of clearing the cache wholesale, which keeps the UI
 * from flickering back to skeletons after every small action.
 */

export const keys = {
  organization: ['organization'] as const,
  members: ['organization', 'members'] as const,
  dashboard: ['dashboard'] as const,
  trends: (params?: unknown) => ['trends', params] as const,
  trend: (id: string) => ['trends', id] as const,
  niches: ['niches'] as const,
  opportunities: (params?: unknown) => ['opportunities', params] as const,
  opportunity: (id: string) => ['opportunities', id] as const,
  research: (params?: unknown) => ['research', params] as const,
  researchSources: ['research', 'sources'] as const,
  workflow: (id: string) => ['workflow', id] as const,
  content: (params?: unknown) => ['content', params] as const,
  contentItem: (id: string) => ['content', id] as const,
  contentVersions: (id: string) => ['content', id, 'versions'] as const,
  campaigns: (params?: unknown) => ['campaigns', params] as const,
  campaign: (id: string) => ['campaigns', id] as const,
  integrations: ['integrations'] as const,
  analyticsOverview: (days: number) => ['analytics', 'overview', days] as const,
  analyticsPosts: ['analytics', 'posts'] as const,
  insights: (status?: string) => ['insights', status] as const,
  agents: ['agents'] as const,
  agentExecutions: (params?: unknown) => ['agents', 'executions', params] as const,
  knowledge: ['knowledge'] as const,
  notifications: (unreadOnly: boolean) => ['notifications', unreadOnly] as const,
  copilotThreads: ['copilot', 'threads'] as const,
  copilotThread: (id: string) => ['copilot', 'threads', id] as const,
};

/** Surfaces a failed mutation as a toast, using the API's own message. */
function reportError(error: unknown): void {
  if (error instanceof ApiError) {
    // Capability and configuration problems carry an actionable requirement.
    toast.error(error.message, {
      description: error.requirement ?? error.issues.map((i) => i.message).join(' ') ?? undefined,
      duration: error.isCapabilityIssue ? 10_000 : 6_000,
    });
    return;
  }
  toast.error(error instanceof Error ? error.message : 'Something went wrong.');
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export function useOrganization(): UseQueryResult<Organization, ApiError> {
  return useQuery({
    queryKey: keys.organization,
    queryFn: () => apiRequest<Organization>('/api/v1/organization'),
  });
}

export function useMembers(): UseQueryResult<Member[], ApiError> {
  return useQuery({
    queryKey: keys.members,
    queryFn: () => apiRequest<Member[]>('/api/v1/organization/members'),
  });
}

export function useUpdateOrganization() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<Organization>('/api/v1/organization', { method: 'PATCH', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.organization });
      toast.success('Organization updated.');
    },
    onError: reportError,
  });
}

export function useCreateOrganization() {
  return useMutation({
    mutationFn: (body: { name: string; websiteUrl?: string; timezone?: string }) =>
      apiRequest<{ id: string; name: string; slug: string }>('/api/v1/organizations', {
        method: 'POST',
        body,
      }),
    onError: reportError,
  });
}

export function useAddMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { email?: string; privyUserId?: string; role: string }) =>
      apiRequest<Member>('/api/v1/organization/members', { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.members });
      toast.success('Member added.');
    },
    onError: reportError,
  });
}

export function useUpdateMemberRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) =>
      apiRequest<Member>(`/api/v1/organization/members/${id}`, { method: 'PATCH', body: { role } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.members });
      toast.success('Role updated.');
    },
    onError: reportError,
  });
}

export function useRemoveMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ removed: boolean }>(`/api/v1/organization/members/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.members });
      toast.success('Member removed.');
    },
    onError: reportError,
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function useDashboard(): UseQueryResult<DashboardData, ApiError> {
  return useQuery({
    queryKey: keys.dashboard,
    queryFn: () => apiRequest<DashboardData>('/api/v1/dashboard'),
    // The dashboard shows live publishing and agent state, so it refreshes.
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Research, trends, niches, opportunities
// ---------------------------------------------------------------------------

export function useResearchItems(params: { search?: string; sourceId?: string; limit?: number }) {
  return useQuery({
    queryKey: keys.research(params),
    queryFn: () =>
      apiRequest<Page<ResearchItem>>(`/api/v1/research${query({ ...params, limit: params.limit ?? 30 })}`),
  });
}

export function useResearchSources(): UseQueryResult<
  { sources: ResearchSource[]; sourceTypes: SourceTypeAvailability[] },
  ApiError
> {
  return useQuery({
    queryKey: keys.researchSources,
    queryFn: () =>
      apiRequest<{ sources: ResearchSource[]; sourceTypes: SourceTypeAvailability[] }>(
        '/api/v1/research/sources',
      ),
  });
}

export function useCreateResearchSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { type: string; name: string; config: Record<string, unknown> }) =>
      apiRequest<ResearchSource>('/api/v1/research/sources', { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.researchSources });
      toast.success('Research source added.');
    },
    onError: reportError,
  });
}

export function useDeleteResearchSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ deleted: boolean }>(`/api/v1/research/sources/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.researchSources });
      toast.success('Source removed.');
    },
    onError: reportError,
  });
}

export function useRunResearch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { sourceIds?: string[] }) =>
      apiRequest<{ workflowExecutionId: string; status: string; sourceCount: number }>(
        '/api/v1/research/run',
        { method: 'POST', body },
      ),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: keys.researchSources });
      toast.success(`Research started across ${result.sourceCount} sources.`, {
        description: 'Collection and scoring run in the background.',
      });
    },
    onError: reportError,
  });
}

/** Polls a workflow while it is still running. */
export function useWorkflow(id: string | null) {
  return useQuery({
    queryKey: keys.workflow(id ?? ''),
    enabled: Boolean(id),
    queryFn: () => apiRequest<WorkflowExecution>(`/api/v1/research/runs/${id}`),
    refetchInterval: (fetched) => {
      const status = fetched.state.data?.status;
      return status === 'PENDING' || status === 'RUNNING' ? 3_000 : false;
    },
  });
}

export function useTrends(params: { limit?: number; minScore?: number } = {}) {
  return useQuery({
    queryKey: keys.trends(params),
    queryFn: () => apiRequest<Trend[]>(`/api/v1/trends${query({ ...params, limit: params.limit ?? 30 })}`),
  });
}

export function useTrend(id: string) {
  return useQuery({
    queryKey: keys.trend(id),
    queryFn: () => apiRequest<TrendDetail>(`/api/v1/trends/${id}`),
  });
}

export function useNiches(limit = 30) {
  return useQuery({
    queryKey: keys.niches,
    queryFn: () => apiRequest<Niche[]>(`/api/v1/niches${query({ limit })}`),
  });
}

export function useDiscoverNiches() {
  return useMutation({
    mutationFn: () =>
      apiRequest<{ workflowExecutionId: string }>('/api/v1/niches/discover', { method: 'POST' }),
    onSuccess: () => toast.success('Niche discovery started.'),
    onError: reportError,
  });
}

export function useOpportunities(params: { status?: OpportunityStatus; limit?: number } = {}) {
  return useQuery({
    queryKey: keys.opportunities(params),
    queryFn: () =>
      apiRequest<Page<Opportunity>>(
        `/api/v1/opportunities${query({ ...params, limit: params.limit ?? 30 })}`,
      ),
  });
}

export function useOpportunity(id: string) {
  return useQuery({
    queryKey: keys.opportunity(id),
    queryFn: () => apiRequest<OpportunityDetail>(`/api/v1/opportunities/${id}`),
  });
}

export function useGenerateOpportunities() {
  return useMutation({
    mutationFn: () =>
      apiRequest<{ workflowExecutionId: string }>('/api/v1/opportunities', { method: 'POST' }),
    onSuccess: () => toast.success('Opportunity generation started.'),
    onError: reportError,
  });
}

export function useUpdateOpportunity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: OpportunityStatus }) =>
      apiRequest<Opportunity>(`/api/v1/opportunities/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: (_data, variables) => {
      void client.invalidateQueries({ queryKey: ['opportunities'] });
      void client.invalidateQueries({ queryKey: keys.opportunity(variables.id) });
      void client.invalidateQueries({ queryKey: keys.dashboard });
    },
    onError: reportError,
  });
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export function useContentList(
  params: {
    status?: ContentStatus;
    contentType?: ContentType;
    campaignId?: string;
    scheduledFrom?: string;
    scheduledTo?: string;
    limit?: number;
  } = {},
) {
  return useQuery({
    queryKey: keys.content(params),
    queryFn: () =>
      apiRequest<Page<ContentItem>>(`/api/v1/content${query({ ...params, limit: params.limit ?? 50 })}`),
  });
}

export function useContentItem(id: string) {
  return useQuery({
    queryKey: keys.contentItem(id),
    queryFn: () => apiRequest<ContentItemDetail>(`/api/v1/content/${id}`),
  });
}

export function useContentVersions(id: string) {
  return useQuery({
    queryKey: keys.contentVersions(id),
    queryFn: () => apiRequest<ContentVersion[]>(`/api/v1/content/${id}/versions`),
  });
}

export function useCreateContent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<ContentItemDetail>('/api/v1/content', { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['content'] });
      toast.success('Draft created.');
    },
    onError: reportError,
  });
}

export function useUpdateContent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<ContentItemDetail>(`/api/v1/content/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.contentItem(id) });
      void client.invalidateQueries({ queryKey: keys.contentVersions(id) });
      void client.invalidateQueries({ queryKey: ['content'] });
    },
    onError: reportError,
  });
}

export function useGenerateContent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { brief?: string }) =>
      apiRequest<{
        content: ContentItemDetail;
        generation: {
          rationale: string;
          approvalReasons: string[];
          platformViolations: Array<{ field: string; code: string; message: string }>;
          verifiedClaims: Array<{ claim: string; verified: boolean }>;
        };
      }>(`/api/v1/content/${id}/generate`, { method: 'POST', body }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: keys.contentItem(id) });
      void client.invalidateQueries({ queryKey: keys.contentVersions(id) });
      const unverified = result.generation.verifiedClaims.filter((c) => !c.verified).length;
      toast.success('Content generated.', {
        description:
          unverified > 0
            ? `${unverified} factual claim(s) are not backed by an approved claim and need review.`
            : undefined,
      });
    },
    onError: reportError,
  });
}

export function useAssistContent(id: string) {
  return useMutation({
    mutationFn: (body: { operation: string; tone?: string; count?: number }) =>
      apiRequest<Record<string, unknown>>(`/api/v1/content/${id}/assist`, { method: 'POST', body }),
    onError: reportError,
  });
}

/** Lifecycle transitions share one hook: they all invalidate the same keys. */
export function useContentAction(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      action,
      body,
    }: {
      action: 'submit' | 'approve' | 'reject' | 'schedule' | 'publish' | 'cancel';
      body?: Record<string, unknown>;
    }) =>
      apiRequest<Record<string, unknown>>(`/api/v1/content/${id}/${action}`, {
        method: 'POST',
        ...(body ? { body } : {}),
      }),
    onSuccess: (_data, variables) => {
      void client.invalidateQueries({ queryKey: keys.contentItem(id) });
      void client.invalidateQueries({ queryKey: ['content'] });
      void client.invalidateQueries({ queryKey: keys.dashboard });
      const messages: Record<string, string> = {
        submit: 'Submitted for approval.',
        approve: 'Approved.',
        reject: 'Rejected.',
        schedule: 'Scheduled.',
        publish: 'Publishing queued. The worker will post it shortly.',
        cancel: 'Cancelled.',
      };
      toast.success(messages[variables.action] ?? 'Done.');
    },
    onError: reportError,
  });
}

export function useDeleteContent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ deleted: boolean }>(`/api/v1/content/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['content'] });
      toast.success('Deleted.');
    },
    onError: reportError,
  });
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export function useCampaigns(params: { status?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: keys.campaigns(params),
    queryFn: () => apiRequest<Campaign[]>(`/api/v1/campaigns${query(params)}`),
  });
}

export function useCampaign(id: string) {
  return useQuery({
    queryKey: keys.campaign(id),
    queryFn: () => apiRequest<CampaignDetail>(`/api/v1/campaigns/${id}`),
  });
}

export function useCreateCampaign() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<Campaign>('/api/v1/campaigns', { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['campaigns'] });
      toast.success('Campaign created.');
    },
    onError: reportError,
  });
}

export function useGenerateCampaign(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { postsPerWeek?: number; opportunityIds?: string[] }) =>
      apiRequest<{ workflowExecutionId: string }>(`/api/v1/campaigns/${id}/generate`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.campaign(id) });
      toast.success('Generating the campaign plan and calendar.', {
        description: 'This runs in the background and can take a minute.',
      });
    },
    onError: reportError,
  });
}

export function useCampaignAction(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: 'activate' | 'pause') =>
      apiRequest<Campaign>(`/api/v1/campaigns/${id}/${action}`, { method: 'POST' }),
    onSuccess: (_data, action) => {
      void client.invalidateQueries({ queryKey: keys.campaign(id) });
      void client.invalidateQueries({ queryKey: ['campaigns'] });
      toast.success(action === 'activate' ? 'Campaign activated.' : 'Campaign paused.');
    },
    onError: reportError,
  });
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export function useIntegrations(): UseQueryResult<{ providers: IntegrationProvider[] }, ApiError> {
  return useQuery({
    queryKey: keys.integrations,
    queryFn: () => apiRequest<{ providers: IntegrationProvider[] }>('/api/v1/integrations'),
  });
}

export function useConnectProvider() {
  return useMutation({
    mutationFn: ({ provider, redirectPath }: { provider: string; redirectPath?: string }) =>
      apiRequest<{ authorizationUrl: string; state: string }>(
        `/api/v1/integrations/${provider.toLowerCase()}/connect`,
        { method: 'POST', body: { redirectPath } },
      ),
    onSuccess: (result) => {
      // Hand the browser to the provider's own consent screen.
      window.location.href = result.authorizationUrl;
    },
    onError: reportError,
  });
}

export function useValidateConnection() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, connectionId }: { provider: string; connectionId: string }) =>
      apiRequest<{ valid: boolean; reason?: string; requiresReauthorization?: boolean }>(
        `/api/v1/integrations/${provider.toLowerCase()}/validate`,
        { method: 'POST', body: { connectionId } },
      ),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: keys.integrations });
      if (result.valid) toast.success('Connection is healthy.');
      else
        toast.error(result.reason ?? 'Connection check failed.', {
          description: result.requiresReauthorization ? 'Reconnect the account.' : undefined,
        });
    },
    onError: reportError,
  });
}

export function useDisconnectProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, connectionId }: { provider: string; connectionId: string }) =>
      apiRequest<{ disconnected: boolean }>(
        `/api/v1/integrations/${provider.toLowerCase()}/disconnect`,
        { method: 'POST', body: { connectionId } },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.integrations });
      toast.success('Account disconnected and its stored tokens deleted.');
    },
    onError: reportError,
  });
}

// ---------------------------------------------------------------------------
// Analytics, insights, agents
// ---------------------------------------------------------------------------

export function useAnalyticsOverview(periodDays = 30) {
  return useQuery({
    queryKey: keys.analyticsOverview(periodDays),
    queryFn: () => apiRequest<AnalyticsOverview>(`/api/v1/analytics/overview${query({ periodDays })}`),
  });
}

export function useAnalyticsPosts(limit = 50) {
  return useQuery({
    queryKey: keys.analyticsPosts,
    queryFn: () => apiRequest<PostAnalytics[]>(`/api/v1/analytics/posts${query({ limit })}`),
  });
}

export function useRunPerformanceReview() {
  return useMutation({
    mutationFn: (body: { periodDays: number }) =>
      apiRequest<{ workflowExecutionId: string }>('/api/v1/analytics/review', {
        method: 'POST',
        body,
      }),
    onSuccess: () =>
      toast.success('Performance review started.', {
        description: 'Proposed insights will appear under Insights when it finishes.',
      }),
    onError: reportError,
  });
}

export function useInsights(status?: 'PROPOSED' | 'ACCEPTED' | 'REJECTED') {
  return useQuery({
    queryKey: keys.insights(status),
    queryFn: () => apiRequest<StrategyInsight[]>(`/api/v1/insights${query({ status })}`),
  });
}

export function useDecideInsight() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'ACCEPTED' | 'REJECTED' }) =>
      apiRequest<{ id: string; status: string }>(`/api/v1/insights/${id}/decide`, {
        method: 'POST',
        body: { decision },
      }),
    onSuccess: (_data, variables) => {
      void client.invalidateQueries({ queryKey: ['insights'] });
      void client.invalidateQueries({ queryKey: keys.dashboard });
      toast.success(variables.decision === 'ACCEPTED' ? 'Insight accepted.' : 'Insight rejected.');
    },
    onError: reportError,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: keys.agents,
    queryFn: () => apiRequest<AgentSummary[]>('/api/v1/agents'),
  });
}

export function useAgentExecutions(params: { agentName?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: keys.agentExecutions(params),
    queryFn: () =>
      apiRequest<AgentExecution[]>(`/api/v1/agents/executions${query({ ...params, limit: params.limit ?? 50 })}`),
    refetchInterval: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export function useKnowledge(): UseQueryResult<KnowledgeOverview, ApiError> {
  return useQuery({
    queryKey: keys.knowledge,
    queryFn: () => apiRequest<KnowledgeOverview>('/api/v1/knowledge'),
  });
}

export function useUpsertBrandProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<Record<string, unknown>>('/api/v1/knowledge/profile', { method: 'PUT', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.knowledge });
      toast.success('Brand profile saved and re-indexed.');
    },
    onError: reportError,
  });
}

export function useCreateKnowledgeEntity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<Record<string, unknown>>('/api/v1/knowledge', { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.knowledge });
      toast.success('Added to the knowledge base.');
    },
    onError: reportError,
  });
}

export function useDeleteKnowledgeEntity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id }: { type: string; id: string }) =>
      apiRequest<{ deleted: boolean }>(`/api/v1/knowledge/${type.toLowerCase()}/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.knowledge });
      toast.success('Removed.');
    },
    onError: reportError,
  });
}

export function useIngestKnowledge() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, body }: { kind: 'url' | 'text'; body: Record<string, unknown> }) =>
      apiRequest<Record<string, unknown>>(`/api/v1/knowledge/${kind}`, { method: 'POST', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.knowledge });
      toast.success('Queued for indexing.');
    },
    onError: reportError,
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function useNotifications(unreadOnly = false) {
  return useQuery({
    queryKey: keys.notifications(unreadOnly),
    queryFn: () => apiRequest<Notification[]>(`/api/v1/notifications${query({ unreadOnly })}`),
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiRequest<{ marked: number }>('/api/v1/notifications/read', { method: 'POST', body: { ids } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['notifications'] }),
    onError: reportError,
  });
}

// ---------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------

export function useCopilotThreads() {
  return useQuery({
    queryKey: keys.copilotThreads,
    queryFn: () => apiRequest<CopilotThread[]>('/api/v1/copilot/threads'),
  });
}

export function useCopilotThread(id: string | null) {
  return useQuery({
    queryKey: keys.copilotThread(id ?? ''),
    enabled: Boolean(id),
    queryFn: () => apiRequest<CopilotThreadDetail>(`/api/v1/copilot/threads/${id}`),
  });
}

export function useCreateCopilotThread() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { title?: string }) =>
      apiRequest<CopilotThread>('/api/v1/copilot/threads', { method: 'POST', body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.copilotThreads }),
    onError: reportError,
  });
}

export function useSendCopilotMessage(
  threadId: string | null,
): UseMutationResult<CopilotReply, unknown, { message: string; confirmedActionIds?: string[] }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { message: string; confirmedActionIds?: string[] }) =>
      apiRequest<CopilotReply>(`/api/v1/copilot/threads/${threadId}/messages`, {
        method: 'POST',
        body: { message: body.message, confirmedActionIds: body.confirmedActionIds ?? [] },
      }),
    onSuccess: () => {
      if (threadId) void client.invalidateQueries({ queryKey: keys.copilotThread(threadId) });
      void client.invalidateQueries({ queryKey: keys.copilotThreads });
    },
    onError: reportError,
  });
}
