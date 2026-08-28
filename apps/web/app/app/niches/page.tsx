'use client';

import { Layers, Sparkles } from 'lucide-react';
import { useDiscoverNiches, useNiches } from '@/lib/queries';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  PageHeader,
  ScoreBar,
  Skeleton,
} from '@/components/ui';

/**
 * Niches.
 *
 * Micro-niches derived from detected trends. The rationale matters more than the
 * score here: a niche is only useful if there is a specific reason this brand
 * can credibly own it.
 */
export default function NichesPage() {
  const niches = useNiches(50);
  const discover = useDiscoverNiches();

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Niches"
        description="Narrow spaces this brand could realistically become the recognised voice in, derived from current trends."
        actions={
          <Button
            variant="primary"
            onClick={() => discover.mutate()}
            loading={discover.isPending}
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            Discover niches
          </Button>
        }
      />

      {niches.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-48" />
          ))}
        </div>
      ) : niches.error ? (
        <ErrorState error={niches.error} onRetry={() => void niches.refetch()} />
      ) : (niches.data ?? []).length === 0 ? (
        <EmptyState
          icon={<Layers className="h-8 w-8" />}
          title="No niches discovered yet"
          description="Niche discovery works from detected trends, so run research first. Then use Discover niches to derive specific spaces worth owning."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(niches.data ?? []).map((niche) => (
            <Card key={niche.id}>
              <CardContent className="pt-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-display text-base font-semibold">{niche.name}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{niche.description}</p>
                  </div>
                  <p className="tabular shrink-0 font-display text-3xl font-bold text-primary">
                    {Math.round(niche.score)}
                  </p>
                </div>

                {niche.rationale ? (
                  <p className="mt-3 rounded-lg border border-border/60 bg-surface-raised/40 p-3 text-sm">
                    <span className="font-medium text-accent">Why it matters: </span>
                    {niche.rationale}
                  </p>
                ) : null}

                <div className="mt-4 space-y-1.5">
                  <ScoreBar label="Relevance" value={niche.components.relevance ?? 0} />
                  <ScoreBar
                    label="Audience fit"
                    value={niche.components.audienceFit ?? 0}
                    tone="accent"
                  />
                  <ScoreBar
                    label="Growth"
                    value={niche.components.growthSignal ?? 0}
                    tone="success"
                  />
                  <ScoreBar
                    label="Competition"
                    value={niche.components.competition ?? 0}
                    tone="warning"
                  />
                </div>

                {niche.audience ? (
                  <div className="mt-3">
                    <Badge tone="accent">{niche.audience.name}</Badge>
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
