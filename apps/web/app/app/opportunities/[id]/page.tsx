'use client';

import { ArrowLeft, FileText, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { CONTENT_TYPES } from '@kult/shared';
import { useCreateContent, useOpportunity, useUpdateOpportunity } from '@/lib/queries';
import { formatContentType, relativeTime } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  Modal,
  ScoreBar,
  Select,
  Skeleton,
  statusTone,
} from '@/components/ui';

/**
 * Opportunity detail.
 *
 * The point of this screen is the hand-off into content: it shows what the
 * opportunity rests on, then creates a draft wired back to it so the resulting
 * post keeps its provenance.
 */
export default function OpportunityDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const opportunity = useOpportunity(params.id);
  const createContent = useCreateContent();
  const updateOpportunity = useUpdateOpportunity();

  const [createOpen, setCreateOpen] = useState(false);
  const [contentType, setContentType] = useState<string>('X_POST');

  if (opportunity.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (opportunity.error) {
    return <ErrorState error={opportunity.error} onRetry={() => void opportunity.refetch()} />;
  }

  const data = opportunity.data;
  if (!data) return null;

  async function handleCreateContent(): Promise<void> {
    const draft = await createContent.mutateAsync({
      contentType,
      title: data!.title.slice(0, 200),
      // The opportunity becomes the brief the generation agent works from.
      body: `${data!.title}\n\n${data!.description}${
        data!.recommendedAction ? `\n\nRecommended: ${data!.recommendedAction}` : ''
      }`,
      opportunityId: data!.id,
    });
    // Converting an opportunity is what takes it out of the queue.
    updateOpportunity.mutate({ id: data!.id, status: 'CONVERTED' });
    setCreateOpen(false);
    router.push(`/app/content/${(draft as { id: string }).id}`);
  }

  return (
    <div className="animate-fade-in space-y-6">
      <Link
        href="/app/opportunities"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All opportunities
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(data.status)}>{data.status}</Badge>
            {data.platform ? <Badge tone="accent">{data.platform}</Badge> : null}
            {data.contentFormat ? <Badge>{formatContentType(data.contentFormat)}</Badge> : null}
            {data.expiresAt ? (
              <span className="text-xs text-muted-foreground">
                expires {relativeTime(data.expiresAt)}
              </span>
            ) : null}
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{data.title}</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{data.description}</p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Opportunity score</p>
          <p className="tabular font-display text-5xl font-bold text-primary">
            {Math.round(data.opportunityScore)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <FileText className="h-4 w-4" aria-hidden />
          Create content from this
        </Button>
        {data.status !== 'DISMISSED' ? (
          <Button
            variant="ghost"
            onClick={() => updateOpportunity.mutate({ id: data.id, status: 'DISMISSED' })}
          >
            Dismiss
          </Button>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Score breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <ScoreBar label="Trend strength" value={data.trendScore} tone="accent" />
            <ScoreBar label="Brand relevance" value={data.relevanceScore} />
            <ScoreBar label="Competition" value={data.competitionScore} tone="warning" />
            <ScoreBar label="Risk" value={data.riskScore} tone="danger" />
            <p className="pt-2 text-xs text-muted-foreground">
              Competition and risk subtract from the total. Historical performance of this
              platform and format also feeds the score.
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Reasoning</CardTitle>
          </CardHeader>
          <CardContent>
            {data.rationale ? (
              <p className="text-sm leading-relaxed">{data.rationale}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No reasoning was recorded.</p>
            )}
            {data.recommendedAction ? (
              <p className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
                <span className="font-medium text-accent">Recommended action: </span>
                {data.recommendedAction}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Supporting trends</CardTitle>
          </CardHeader>
          <CardContent>
            {data.trends.length === 0 ? (
              <p className="text-sm text-muted-foreground">No trends are linked.</p>
            ) : (
              <ul className="space-y-2">
                {data.trends.map(({ trend }) => (
                  <li key={trend.id}>
                    <Link
                      href={`/app/trends/${trend.id}`}
                      className="flex items-start gap-3 rounded-lg border border-border/50 p-3 transition-colors hover:border-border-strong"
                    >
                      <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{trend.name}</p>
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

        <Card>
          <CardHeader>
            <CardTitle>Supporting niches</CardTitle>
          </CardHeader>
          <CardContent>
            {data.niches.length === 0 ? (
              <p className="text-sm text-muted-foreground">No niches are linked.</p>
            ) : (
              <ul className="space-y-2">
                {data.niches.map(({ niche }) => (
                  <li
                    key={niche.id}
                    className="flex items-center justify-between rounded-lg border border-border/50 p-3"
                  >
                    <span className="text-sm">{niche.name}</span>
                    <span className="tabular text-sm font-semibold text-primary">
                      {Math.round(niche.score)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create content"
        description="Creates a draft linked to this opportunity. You generate and edit the copy in the studio."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateContent}
              loading={createContent.isPending}
            >
              Create draft
            </Button>
          </>
        }
      >
        <Field label="Content type">
          <Select value={contentType} onChange={(event) => setContentType(event.target.value)}>
            {CONTENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {formatContentType(type)}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>
    </div>
  );
}
