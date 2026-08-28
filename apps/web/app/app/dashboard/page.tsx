'use client';

import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  Plug,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import { useSession } from '@/components/providers';
import { useDashboard, useOrganization } from '@/lib/queries';
import { formatContentType, formatInTimezone, relativeTime } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  ScoreBar,
  Skeleton,
  statusTone,
} from '@/components/ui';

/**
 * Dashboard.
 *
 * Answers one question on open: what deserves attention right now. The top
 * opportunity is given the most space because acting on it is the product's
 * whole point; everything else is a queue of things needing a decision.
 */
export default function DashboardPage() {
  const { me } = useSession();
  const organization = useOrganization();
  const dashboard = useDashboard();

  const firstName = me?.user.displayName?.split(' ')[0] ?? null;

  if (dashboard.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-48 w-full" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (dashboard.error) {
    return <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />;
  }

  const data = dashboard.data;
  if (!data) return null;

  const topOpportunity = data.opportunities.top[0];
  const unhealthyConnections = data.connections.filter(
    (connection) => connection.status !== 'ACTIVE' || connection.tokenExpired,
  );

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {greeting()}
          {firstName ? `, ${firstName}` : ''}.
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {data.opportunities.openCount > 0
            ? `${data.opportunities.openCount} marketing ${data.opportunities.openCount === 1 ? 'opportunity' : 'opportunities'} waiting on a decision.`
            : 'No open opportunities. Run research to find some.'}
        </p>
      </div>

      {/* Things that are actively broken come first. */}
      {unhealthyConnections.length > 0 || data.publishing.failedCount > 0 ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              <div>
                <p className="text-sm font-medium">Needs attention</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {[
                    unhealthyConnections.length > 0
                      ? `${unhealthyConnections.length} social ${unhealthyConnections.length === 1 ? 'connection needs' : 'connections need'} reconnecting`
                      : null,
                    data.publishing.failedCount > 0
                      ? `${data.publishing.failedCount} failed ${data.publishing.failedCount === 1 ? 'publication' : 'publications'}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {unhealthyConnections.length > 0 ? (
                <Link href="/app/integrations">
                  <Button variant="outline" size="sm">
                    <Plug className="h-3.5 w-3.5" aria-hidden />
                    Integrations
                  </Button>
                </Link>
              ) : null}
              {data.publishing.failedCount > 0 ? (
                <Link href="/app/content?status=FAILED">
                  <Button variant="outline" size="sm">
                    Review failures
                  </Button>
                </Link>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Top opportunity */}
      {topOpportunity ? (
        <Card className="border-primary/30">
          <CardContent className="pt-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex items-center gap-2">
                  <Badge tone="primary">
                    <Sparkles className="h-3 w-3" aria-hidden />
                    Top opportunity
                  </Badge>
                  {topOpportunity.expiresAt ? (
                    <Badge tone="warning">Expires {relativeTime(topOpportunity.expiresAt)}</Badge>
                  ) : null}
                </div>
                <h2 className="font-display text-xl font-bold">{topOpportunity.title}</h2>
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                  {topOpportunity.description}
                </p>

                {topOpportunity.recommendedAction ? (
                  <p className="mt-3 rounded-lg border border-border/60 bg-surface-raised/50 p-3 text-sm">
                    <span className="font-medium text-accent">Recommended: </span>
                    {topOpportunity.recommendedAction}
                  </p>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  {topOpportunity.platform ? (
                    <Badge tone="accent">{topOpportunity.platform}</Badge>
                  ) : null}
                  {topOpportunity.contentFormat ? (
                    <Badge>{formatContentType(topOpportunity.contentFormat)}</Badge>
                  ) : null}
                </div>
              </div>

              <div className="w-full max-w-xs shrink-0">
                <div className="mb-3 text-right">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Opportunity score
                  </p>
                  <p className="tabular font-display text-4xl font-bold text-primary">
                    {Math.round(topOpportunity.opportunityScore)}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <ScoreBar label="Trend" value={topOpportunity.trendScore} tone="accent" />
                  <ScoreBar label="Relevance" value={topOpportunity.relevanceScore} tone="primary" />
                  <ScoreBar
                    label="Competition"
                    value={topOpportunity.competitionScore}
                    tone="warning"
                  />
                  <ScoreBar label="Risk" value={topOpportunity.riskScore} tone="danger" />
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <Link href={`/app/opportunities/${topOpportunity.id}`}>
                <Button variant="primary">
                  Review and create content
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              </Link>
              <Link href="/app/opportunities">
                <Button variant="ghost">View all opportunities</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={<Sparkles className="h-8 w-8" />}
          title="No opportunities yet"
          description="Add research sources and run research. Trends are detected from what it collects, and opportunities are generated from those trends."
          action={
            <Link href="/app/research">
              <Button variant="primary">Set up research</Button>
            </Link>
          }
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Awaiting approval */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Awaiting approval</CardTitle>
            <Link href="/app/content?status=PENDING_APPROVAL" className="text-xs text-accent hover:underline">
              View all
            </Link>
          </CardHeader>
          <CardContent>
            {data.needsApproval.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing waiting on review.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.needsApproval.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/app/content/${item.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/50 p-3 transition-colors hover:border-border-strong"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {item.title ?? formatContentType(item.contentType)}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge>{formatContentType(item.contentType)}</Badge>
                          {item.riskLevel !== 'LOW' ? (
                            <Badge tone={statusTone(item.riskLevel)}>{item.riskLevel} risk</Badge>
                          ) : null}
                          {item.flaggedTopics.slice(0, 2).map((topic) => (
                            <Badge key={topic} tone="warning">
                              {topic.replace(/_/g, ' ').toLowerCase()}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Upcoming */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Scheduled next</CardTitle>
            <Link href="/app/calendar" className="text-xs text-accent hover:underline">
              Calendar
            </Link>
          </CardHeader>
          <CardContent>
            {data.upcomingContent.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing scheduled this week.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.upcomingContent.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/app/content/${item.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/50 p-3 transition-colors hover:border-border-strong"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {item.title ?? formatContentType(item.contentType)}
                        </p>
                        <p className="tabular mt-0.5 text-xs text-muted-foreground">
                          <CalendarClock className="mr-1 inline h-3 w-3" aria-hidden />
                          {formatInTimezone(item.scheduledAt, organization.data?.timezone)}
                        </p>
                      </div>
                      <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Trends */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Trending now</CardTitle>
            <Link href="/app/trends" className="text-xs text-accent hover:underline">
              All trends
            </Link>
          </CardHeader>
          <CardContent>
            {data.trends.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No trends detected yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.trends.map((trend) => (
                  <li key={trend.id}>
                    <Link
                      href={`/app/trends/${trend.id}`}
                      className="flex items-start gap-3 rounded-lg border border-border/50 p-3 transition-colors hover:border-border-strong"
                    >
                      <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{trend.name}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {trend.summary}
                        </p>
                      </div>
                      <span className="tabular shrink-0 text-sm font-semibold text-primary">
                        {Math.round(trend.score)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Agent activity */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Agent activity</CardTitle>
            <Link href="/app/agents" className="text-xs text-accent hover:underline">
              Full log
            </Link>
          </CardHeader>
          <CardContent>
            {data.agentActivity.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No agent runs in the last 24 hours.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {data.agentActivity.slice(0, 8).map((execution) => (
                  <li
                    key={execution.id}
                    className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm"
                  >
                    <span className="tabular w-14 shrink-0 text-xs text-muted-foreground">
                      {new Date(execution.startedAt).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{execution.agentName}</span>
                    <Badge tone={statusTone(execution.status)}>{execution.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recently published */}
      {data.publishing.recent.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recently published</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {data.publishing.recent.map((publication) => (
                <li
                  key={publication.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                      <p className="truncate text-sm font-medium">
                        {publication.contentItem.title ??
                          formatContentType(publication.contentItem.contentType)}
                      </p>
                    </div>
                    <p className="tabular mt-0.5 text-xs text-muted-foreground">
                      {publication.provider} ·{' '}
                      {publication.publishedAt
                        ? new Date(publication.publishedAt).toLocaleString()
                        : 'unknown time'}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    {publication.latestMetrics ? (
                      <div className="tabular flex gap-3 text-xs text-muted-foreground">
                        <span>
                          {publication.latestMetrics.impressions?.toLocaleString() ?? '—'} views
                        </span>
                        <span>{publication.latestMetrics.likes?.toLocaleString() ?? '—'} likes</span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Metrics not collected yet</span>
                    )}
                    {publication.providerUrl ? (
                      <a
                        href={publication.providerUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-xs text-accent hover:underline"
                      >
                        View post
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* Proposed insights */}
      {data.proposedInsights.length > 0 ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>AI recommendations awaiting your decision</CardTitle>
            <Link href="/app/analytics" className="text-xs text-accent hover:underline">
              Review
            </Link>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {data.proposedInsights.map((insight) => (
                <li key={insight.id} className="rounded-lg border border-border/50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm">{insight.recommendation}</p>
                    <Badge tone="neutral">
                      {Math.round(insight.confidence * 100)}% confidence
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}


