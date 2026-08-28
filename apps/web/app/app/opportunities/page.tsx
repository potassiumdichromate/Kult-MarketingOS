'use client';

import { Check, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { OPPORTUNITY_STATUSES } from '@kult/shared';
import { useGenerateOpportunities, useOpportunities, useUpdateOpportunity } from '@/lib/queries';
import { formatContentType, relativeTime } from '@/lib/format';
import type { OpportunityStatus } from '@/lib/types';
import {
  Badge,
  Button,
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
 * Opportunities.
 *
 * The queue that answers "what should we talk about right now". Each row is a
 * decision: select it and turn it into content, or dismiss it. Dismissing is a
 * first-class action so the list stays a real queue rather than an ignored feed.
 */
export default function OpportunitiesPage() {
  const [status, setStatus] = useState<OpportunityStatus | ''>('');
  const opportunities = useOpportunities({
    ...(status ? { status } : {}),
    limit: 50,
  });
  const generate = useGenerateOpportunities();
  const updateOpportunity = useUpdateOpportunity();

  const items = opportunities.data?.items ?? [];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Opportunities"
        description="Scored from the trends and niches behind them, plus how this platform and format have performed for you before."
        actions={
          <>
            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value as OpportunityStatus | '')}
              className="w-40"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {OPPORTUNITY_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => generate.mutate()} loading={generate.isPending}>
              <Sparkles className="h-4 w-4" aria-hidden />
              Generate
            </Button>
          </>
        }
      />

      {opportunities.isLoading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-40" />
          ))}
        </div>
      ) : opportunities.error ? (
        <ErrorState error={opportunities.error} onRetry={() => void opportunities.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="h-8 w-8" />}
          title="No opportunities"
          description="Opportunities are generated from current trends and niches. Run research first, then generate."
          action={
            <Button variant="primary" onClick={() => generate.mutate()} loading={generate.isPending}>
              Generate opportunities
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {items.map((opportunity) => (
            <Card key={opportunity.id}>
              <CardContent className="pt-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge tone={statusTone(opportunity.status)}>{opportunity.status}</Badge>
                      {opportunity.platform ? (
                        <Badge tone="accent">{opportunity.platform}</Badge>
                      ) : null}
                      {opportunity.contentFormat ? (
                        <Badge>{formatContentType(opportunity.contentFormat)}</Badge>
                      ) : null}
                      {opportunity.expiresAt ? (
                        <span className="text-xs text-muted-foreground">
                          expires {relativeTime(opportunity.expiresAt)}
                        </span>
                      ) : null}
                    </div>

                    <Link href={`/app/opportunities/${opportunity.id}`}>
                      <h2 className="font-display text-lg font-semibold hover:text-primary">
                        {opportunity.title}
                      </h2>
                    </Link>
                    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                      {opportunity.description}
                    </p>

                    {opportunity.recommendedAction ? (
                      <p className="mt-2 text-sm">
                        <span className="font-medium text-accent">Recommended: </span>
                        {opportunity.recommendedAction}
                      </p>
                    ) : null}
                  </div>

                  <div className="w-full max-w-[220px] shrink-0">
                    <div className="mb-2 text-right">
                      <p className="tabular font-display text-3xl font-bold text-primary">
                        {Math.round(opportunity.opportunityScore)}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <ScoreBar label="Trend" value={opportunity.trendScore} tone="accent" />
                      <ScoreBar label="Relevance" value={opportunity.relevanceScore} />
                      <ScoreBar
                        label="Risk"
                        value={opportunity.riskScore}
                        tone="danger"
                      />
                    </div>
                  </div>
                </div>

                {opportunity.status === 'NEW' || opportunity.status === 'REVIEWED' ? (
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-border/50 pt-4">
                    <Link href={`/app/opportunities/${opportunity.id}`}>
                      <Button variant="primary" size="sm">
                        Create content
                      </Button>
                    </Link>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        updateOpportunity.mutate({ id: opportunity.id, status: 'SELECTED' })
                      }
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      Select
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        updateOpportunity.mutate({ id: opportunity.id, status: 'DISMISSED' })
                      }
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                      Dismiss
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
