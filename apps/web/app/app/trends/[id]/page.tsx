'use client';

import { ArrowLeft, ExternalLink, Info } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTrend } from '@/lib/queries';
import { formatInTimezone, relativeTime } from '@/lib/format';
import { useOrganization } from '@/lib/queries';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  ScoreBar,
  Skeleton,
  statusTone,
} from '@/components/ui';

/**
 * Trend detail.
 *
 * The distinction this screen makes deliberately visible: the evidence list is
 * real research items with real URLs, while the rationale is AI-written prose
 * explaining a score that was already computed. The rationale is labelled as
 * such and never presented as a source.
 */
export default function TrendDetailPage() {
  const params = useParams<{ id: string }>();
  const trend = useTrend(params.id);
  const organization = useOrganization();

  if (trend.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (trend.error) {
    return <ErrorState error={trend.error} onRetry={() => void trend.refetch()} />;
  }

  const data = trend.data;
  if (!data) return null;

  const components = Object.entries(data.components).filter(
    ([, value]) => typeof value === 'number',
  );
  const contributions = data.contributions;

  return (
    <div className="animate-fade-in space-y-6">
      <Link
        href="/app/trends"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All trends
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <Badge tone={statusTone(data.status)}>{data.status}</Badge>
            <span className="text-xs text-muted-foreground">
              first detected {relativeTime(data.firstDetectedAt)} · last seen{' '}
              {relativeTime(data.lastSeenAt)}
            </span>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{data.name}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{data.summary}</p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Trend score</p>
          <p className="tabular font-display text-5xl font-bold text-primary">
            {Math.round(data.score)}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Score components</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {components.map(([name, value]) => (
              <ScoreBar
                key={name}
                label={humanise(name)}
                value={value}
                tone={
                  name === 'risk' || name === 'saturation' || name === 'competition'
                    ? 'danger'
                    : 'primary'
                }
              />
            ))}
            <p className="pt-2 text-xs text-muted-foreground">
              Each component is measured or judged independently, then weighted. Saturation,
              competition and risk subtract from the total.
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Why this score</CardTitle>
          </CardHeader>
          <CardContent>
            {data.rationale ? (
              <>
                <p className="text-sm leading-relaxed">{data.rationale}</p>
                <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-border/60 bg-surface-raised/40 p-2.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  Written by the trend research agent to explain a score that was already
                  calculated. It is an explanation, not evidence — the sources below are the
                  evidence.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No explanation was generated.</p>
            )}

            {Object.keys(contributions).length > 0 ? (
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Contribution to total
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(contributions).map(([name, value]) => (
                    <Badge key={name} tone={value >= 0 ? 'success' : 'danger'}>
                      <span className="tabular">
                        {humanise(name)} {value >= 0 ? '+' : ''}
                        {Number(value).toFixed(1)}
                      </span>
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Evidence ({data.evidence.length} sources)</CardTitle>
        </CardHeader>
        <CardContent>
          {data.evidence.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No research items are linked to this trend.
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {data.evidence.map((item) => (
                <li key={item.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      {item.url ? (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-start gap-1.5 text-sm font-medium hover:text-accent hover:underline"
                        >
                          {item.title}
                          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                        </a>
                      ) : (
                        <p className="text-sm font-medium">{item.title}</p>
                      )}
                      <p className="tabular mt-1 text-xs text-muted-foreground">
                        {item.sourceType}
                        {item.author ? ` · ${item.author}` : ''}
                        {item.publishedAt
                          ? ` · ${formatInTimezone(item.publishedAt, organization.data?.timezone, { dateStyle: 'medium' })}`
                          : ''}
                      </p>
                    </div>
                    {Object.keys(item.engagement).length > 0 ? (
                      <div className="tabular shrink-0 text-xs text-muted-foreground">
                        {Object.entries(item.engagement)
                          .slice(0, 3)
                          .map(([key, value]) => `${humanise(key)} ${value}`)
                          .join(' · ')}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function humanise(value: string): string {
  return value
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, (char) => char.toUpperCase())
    .trim();
}
