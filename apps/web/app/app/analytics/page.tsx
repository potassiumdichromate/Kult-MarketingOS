'use client';

import { AlertCircle, BarChart3, Check, Play, X } from 'lucide-react';
import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  useAnalyticsOverview,
  useAnalyticsPosts,
  useDecideInsight,
  useInsights,
  useRunPerformanceReview,
} from '@/lib/queries';
import { formatContentType, formatMetric, formatPercent, truncate } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  statusTone,
} from '@/components/ui';

/**
 * Analytics.
 *
 * The design rule that shapes this whole screen: a metric a provider does not
 * report is rendered as an em dash with the reason, never as zero. The
 * "metric gaps" panel exists so a missing number is explained rather than read
 * as poor performance.
 */
export default function AnalyticsPage() {
  const [periodDays, setPeriodDays] = useState(30);

  const overview = useAnalyticsOverview(periodDays);
  const posts = useAnalyticsPosts(50);
  const insights = useInsights();
  const runReview = useRunPerformanceReview();
  const decide = useDecideInsight();

  const proposed = (insights.data ?? []).filter((insight) => insight.status === 'PROPOSED');

  const chartData = (posts.data ?? [])
    .filter((post) => post.latestMetrics)
    .slice(0, 12)
    .reverse()
    .map((post) => ({
      name: truncate(post.contentItem.title ?? formatContentType(post.contentItem.contentType), 18),
      impressions: post.latestMetrics?.impressions ?? 0,
      engagements:
        (post.latestMetrics?.likes ?? 0) +
        (post.latestMetrics?.comments ?? 0) +
        (post.latestMetrics?.shares ?? 0),
    }));

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="Analytics"
        description="Measured from collected metric snapshots. Nothing here is estimated."
        actions={
          <>
            <Select
              value={String(periodDays)}
              onChange={(event) => setPeriodDays(Number(event.target.value))}
              className="w-36"
              aria-label="Period"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </Select>
            <Button
              variant="primary"
              onClick={() => runReview.mutate({ periodDays })}
              loading={runReview.isPending}
            >
              <Play className="h-4 w-4" aria-hidden />
              Run review
            </Button>
          </>
        }
      />

      {overview.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : overview.error ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : overview.data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Posts published" value={overview.data.totals.posts} />
            <Stat
              label="Impressions"
              value={overview.data.totals.impressions}
              unavailableReason="No connected platform reported impressions for this period."
            />
            <Stat
              label="Likes"
              value={overview.data.totals.likes}
              unavailableReason="No connected platform reported likes."
            />
            <Stat
              label="Comments"
              value={overview.data.totals.comments}
              unavailableReason="No connected platform reported comments."
            />
          </div>

          {/* Why numbers may be missing. */}
          {overview.data.metricGaps.length > 0 ? (
            <Card className="border-warning/40 bg-warning/5">
              <CardContent className="pt-5">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                  <div>
                    <p className="text-sm font-medium">Some metrics are unavailable</p>
                    <ul className="mt-1.5 space-y-1">
                      {overview.data.metricGaps.map((gap) => (
                        <li key={gap.provider} className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{gap.provider}:</span>{' '}
                          {gap.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {overview.data.measuredPosts} of {overview.data.totals.posts} published posts have
            collected metrics.
          </p>
        </>
      ) : null}

      {chartData.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent post performance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(210 25% 20%)" vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fill: 'hsl(210 15% 55%)', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    angle={-30}
                    textAnchor="end"
                    height={70}
                  />
                  <YAxis
                    tick={{ fill: 'hsl(210 15% 55%)', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: 'hsl(268 24% 16% / 0.4)' }}
                    contentStyle={{
                      background: 'hsl(220 45% 10%)',
                      border: '1px solid hsl(210 25% 20%)',
                      borderRadius: '0.5rem',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="impressions" fill="hsl(278 88% 58%)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="engagements" fill="hsl(198 92% 68%)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Insights awaiting a human decision */}
      <Card>
        <CardHeader>
          <CardTitle>Strategy insights</CardTitle>
        </CardHeader>
        <CardContent>
          {insights.isLoading ? (
            <Skeleton className="h-32" />
          ) : proposed.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No proposals waiting. Run a review to analyse the period and propose changes.
            </p>
          ) : (
            <ul className="space-y-2">
              {proposed.map((insight) => (
                <li key={insight.id} className="rounded-lg border border-border/50 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="mb-1 flex items-center gap-2">
                        <Badge>{insight.type}</Badge>
                        <Badge tone={insight.confidence >= 0.7 ? 'success' : 'warning'}>
                          {Math.round(insight.confidence * 100)}% confidence
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {insight.supportingContentIds.length} supporting posts
                        </span>
                      </div>
                      <p className="text-sm">{insight.recommendation}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => decide.mutate({ id: insight.id, decision: 'ACCEPTED' })}
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden />
                        Accept
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => decide.mutate({ id: insight.id, decision: 'REJECTED' })}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                        Reject
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Accepting an insight adds it to strategy memory, which later content generation reads.
            Nothing is applied automatically.
          </p>
        </CardContent>
      </Card>

      {/* Per-post table */}
      <Card>
        <CardHeader>
          <CardTitle>Published posts</CardTitle>
        </CardHeader>
        <CardContent>
          {posts.isLoading ? (
            <Skeleton className="h-48" />
          ) : (posts.data ?? []).length === 0 ? (
            <EmptyState
              icon={<BarChart3 className="h-8 w-8" />}
              title="Nothing published yet"
              description="Once content publishes, the worker collects metrics from each platform that supports it."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Post</th>
                    <th className="py-2 pr-3 font-medium">Platform</th>
                    <th className="py-2 pr-3 text-right font-medium">Impressions</th>
                    <th className="py-2 pr-3 text-right font-medium">Likes</th>
                    <th className="py-2 pr-3 text-right font-medium">Comments</th>
                    <th className="py-2 text-right font-medium">Engagement</th>
                  </tr>
                </thead>
                <tbody>
                  {(posts.data ?? []).map((post) => (
                    <tr key={post.id} className="border-b border-border/30 last:border-0">
                      <td className="py-2.5 pr-3">
                        <p className="max-w-xs truncate">
                          {post.contentItem.title ??
                            truncate(post.contentItem.body, 60)}
                        </p>
                        {!post.metricsAvailable ? (
                          <span className="text-xs text-muted-foreground">
                            metrics not collected
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-3">
                        <Badge tone="accent">{post.provider}</Badge>
                      </td>
                      <td className="tabular py-2.5 pr-3 text-right">
                        {formatMetric(post.latestMetrics?.impressions)}
                      </td>
                      <td className="tabular py-2.5 pr-3 text-right">
                        {formatMetric(post.latestMetrics?.likes)}
                      </td>
                      <td className="tabular py-2.5 pr-3 text-right">
                        {formatMetric(post.latestMetrics?.comments)}
                      </td>
                      <td className="tabular py-2.5 text-right">
                        {formatPercent(post.latestMetrics?.engagementRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
