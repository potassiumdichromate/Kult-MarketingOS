'use client';

import { ArrowLeft, Pause, Play, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCampaign, useCampaignAction, useGenerateCampaign, useOrganization } from '@/lib/queries';
import { formatContentType, formatEnum, formatInTimezone } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
  statusTone,
} from '@/components/ui';

/**
 * Campaign detail.
 *
 * The generated plan and its calendar of drafts. Every calendar entry is a real
 * ContentItem, so a campaign is editable piece by piece rather than being a
 * static document that has to be re-run to change.
 */
export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaign = useCampaign(params.id);
  const organization = useOrganization();
  const generate = useGenerateCampaign(params.id);
  const action = useCampaignAction(params.id);

  if (campaign.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (campaign.error) {
    return <ErrorState error={campaign.error} onRetry={() => void campaign.refetch()} />;
  }

  const data = campaign.data;
  if (!data) return null;

  const strategy = data.strategy ?? {};
  const hasPlan = Boolean(strategy.summary) || data.contentItems.length > 0;

  return (
    <div className="animate-fade-in space-y-6">
      <Link
        href="/app/campaigns"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All campaigns
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(data.status)}>{data.status}</Badge>
            {data.template ? <Badge>{formatEnum(data.template)}</Badge> : null}
            {data.platforms.map((platform) => (
              <Badge key={platform} tone="accent">
                {platform}
              </Badge>
            ))}
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{data.name}</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{data.objective}</p>
          <p className="tabular mt-2 text-xs text-muted-foreground">
            {new Date(data.startDate).toLocaleDateString()} –{' '}
            {new Date(data.endDate).toLocaleDateString()} · {data.contentItems.length} pieces
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {data.status === 'DRAFT' ? (
            <Button
              variant="primary"
              onClick={() => generate.mutate({ postsPerWeek: 5 })}
              loading={generate.isPending}
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              {hasPlan ? 'Regenerate plan' : 'Generate plan'}
            </Button>
          ) : null}
          {data.status === 'DRAFT' || data.status === 'PAUSED' ? (
            <Button
              variant="secondary"
              onClick={() => action.mutate('activate')}
              loading={action.isPending}
              disabled={data.contentItems.length === 0}
              title={data.contentItems.length === 0 ? 'Generate content first' : undefined}
            >
              <Play className="h-4 w-4" aria-hidden />
              Activate
            </Button>
          ) : null}
          {data.status === 'ACTIVE' ? (
            <Button variant="secondary" onClick={() => action.mutate('pause')} loading={action.isPending}>
              <Pause className="h-4 w-4" aria-hidden />
              Pause
            </Button>
          ) : null}
        </div>
      </div>

      {!hasPlan ? (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center">
            <Sparkles className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
            <h3 className="mt-3 font-display text-base font-semibold">No plan generated yet</h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Generating produces a strategy, content pillars, a platform split and a dated calendar
              of drafts. Nothing is scheduled or published until you say so.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {strategy.summary ? (
            <Card>
              <CardHeader>
                <CardTitle>Strategy</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm leading-relaxed">{strategy.summary}</p>

                {strategy.audience ? (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Audience
                    </p>
                    <p className="mt-1 text-sm">{strategy.audience}</p>
                  </div>
                ) : null}

                {strategy.contentPillars && strategy.contentPillars.length > 0 ? (
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Content pillars
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {strategy.contentPillars.map((pillar) => (
                        <div
                          key={pillar.name}
                          className="rounded-lg border border-border/50 p-3"
                        >
                          <p className="text-sm font-medium">{pillar.name}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {pillar.description}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {strategy.platformAllocation && strategy.platformAllocation.length > 0 ? (
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Platform allocation
                    </p>
                    <ul className="space-y-1.5">
                      {strategy.platformAllocation.map((allocation) => (
                        <li key={allocation.platform} className="flex items-start gap-3 text-sm">
                          <Badge tone="accent">{allocation.platform}</Badge>
                          <span className="tabular text-muted-foreground">
                            {allocation.postCount} posts
                          </span>
                          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                            {allocation.rationale}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="grid gap-4 sm:grid-cols-2">
                  {strategy.successMetrics && strategy.successMetrics.length > 0 ? (
                    <div>
                      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Success metrics
                      </p>
                      <ul className="space-y-1 text-sm text-muted-foreground">
                        {strategy.successMetrics.map((metric) => (
                          <li key={metric}>· {metric}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {strategy.risks && strategy.risks.length > 0 ? (
                    <div>
                      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Risks
                      </p>
                      <ul className="space-y-1 text-sm text-muted-foreground">
                        {strategy.risks.map((risk) => (
                          <li key={risk}>· {risk}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Content calendar ({data.contentItems.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {data.contentItems.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No content in this campaign yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.contentItems.map((item) => (
                    <li key={item.id}>
                      <Link
                        href={`/app/content/${item.id}`}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 p-3 transition-colors hover:border-border-strong"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {item.title ?? formatContentType(item.contentType)}
                          </p>
                          <p className="tabular mt-0.5 text-xs text-muted-foreground">
                            {formatContentType(item.contentType)}
                            {item.scheduledAt
                              ? ` · ${formatInTimezone(item.scheduledAt, organization.data?.timezone, { dateStyle: 'medium' })}`
                              : ''}
                          </p>
                        </div>
                        <Badge tone={statusTone(item.status)}>
                          {item.status.replace(/_/g, ' ')}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
