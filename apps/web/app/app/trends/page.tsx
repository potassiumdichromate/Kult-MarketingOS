'use client';

import { ExternalLink, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useTrends } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  PageHeader,
  ScoreBar,
  Select,
  Skeleton,
  statusTone,
} from '@/components/ui';

/**
 * Trends.
 *
 * Every score shown here was computed in code from measured signals, not asked
 * of a model. The components are exposed alongside the total so the number can
 * be argued with rather than taken on faith.
 */
export default function TrendsPage() {
  const [minScore, setMinScore] = useState(0);
  const trends = useTrends({ minScore, limit: 50 });

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Trends"
        description="Detected from collected research and scored on velocity, growth, engagement, recency, brand relevance and audience overlap."
        actions={
          <Select
            value={String(minScore)}
            onChange={(event) => setMinScore(Number(event.target.value))}
            className="w-44"
            aria-label="Minimum score"
          >
            <option value="0">All scores</option>
            <option value="40">Score 40+</option>
            <option value="60">Score 60+</option>
            <option value="75">Score 75+</option>
          </Select>
        }
      />

      {trends.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-52" />
          ))}
        </div>
      ) : trends.error ? (
        <ErrorState error={trends.error} onRetry={() => void trends.refetch()} />
      ) : (trends.data ?? []).length === 0 ? (
        <EmptyState
          icon={<TrendingUp className="h-8 w-8" />}
          title="No trends yet"
          description="Trends are clustered from collected research items. Add research sources and run a collection to populate this."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(trends.data ?? []).map((trend) => (
            <Link key={trend.id} href={`/app/trends/${trend.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-primary/40">
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-display text-base font-semibold">{trend.name}</h2>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {trend.summary}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="tabular font-display text-3xl font-bold text-primary">
                        {Math.round(trend.score)}
                      </p>
                      <Badge tone={statusTone(trend.status)}>{trend.status}</Badge>
                    </div>
                  </div>

                  <div className="mt-4 space-y-1.5">
                    <ScoreBar
                      label="Velocity"
                      value={trend.components.velocity ?? 0}
                      tone="accent"
                    />
                    <ScoreBar
                      label="Relevance"
                      value={trend.components.relevance ?? 0}
                      tone="primary"
                    />
                    <ScoreBar
                      label="Competition"
                      value={trend.components.competition ?? 0}
                      tone="warning"
                    />
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <ExternalLink className="h-3 w-3" aria-hidden />
                      {trend._count?.signals ?? 0} sources
                    </span>
                    <span>·</span>
                    <span>seen {relativeTime(trend.lastSeenAt)}</span>
                  </div>

                  {trend.keywords.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {trend.keywords.slice(0, 5).map((keyword) => (
                        <Badge key={keyword}>{keyword}</Badge>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
