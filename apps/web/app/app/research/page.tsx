'use client';

import { AlertCircle, ExternalLink, Play, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { RESEARCH_SOURCE_TYPES } from '@kult/shared';
import {
  useCreateResearchSource,
  useDeleteResearchSource,
  useResearchItems,
  useResearchSources,
  useRunResearch,
  useWorkflow,
} from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  statusTone,
} from '@/components/ui';

/**
 * Research.
 *
 * Two halves: the sources that feed collection, and the items collected. Source
 * types this deployment cannot run are listed with the reason rather than hidden,
 * so it is obvious why something is missing instead of quietly absent.
 */
export default function ResearchPage() {
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [runningWorkflowId, setRunningWorkflowId] = useState<string | null>(null);

  const sources = useResearchSources();
  const items = useResearchItems({ ...(search ? { search } : {}), limit: 40 });
  const runResearch = useRunResearch();
  const deleteSource = useDeleteResearchSource();
  const workflow = useWorkflow(runningWorkflowId);

  const activeSources = (sources.data?.sources ?? []).filter(
    (source) => source.status === 'ACTIVE',
  );

  async function handleRun(): Promise<void> {
    const result = await runResearch.mutateAsync({});
    setRunningWorkflowId(result.workflowExecutionId);
  }

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="Research"
        description="Collects from every configured source, deduplicates by canonical URL, then scores trends from what it finds."
        actions={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Add source
            </Button>
            <Button
              variant="primary"
              onClick={handleRun}
              loading={runResearch.isPending}
              disabled={activeSources.length === 0}
              title={
                activeSources.length === 0
                  ? 'Add at least one runnable source first'
                  : undefined
              }
            >
              <Play className="h-4 w-4" aria-hidden />
              Run research
            </Button>
          </>
        }
      />

      {/* Live progress for the run just started. */}
      {workflow.data && workflow.data.status !== 'SUCCEEDED' ? (
        <Card className="border-accent/40">
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  Research {workflow.data.status.toLowerCase()}
                  {workflow.data.currentStep ? ` — ${workflow.data.currentStep}` : ''}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {workflow.data.steps.map((step) => (
                    <Badge key={step.name} tone={statusTone(step.status)}>
                      {step.name}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            {workflow.data.error ? (
              <p className="mt-3 text-sm text-destructive">{workflow.data.error}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Sources */}
      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
        </CardHeader>
        <CardContent>
          {sources.isLoading ? (
            <Skeleton className="h-32" />
          ) : sources.error ? (
            <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
          ) : (
            <>
              {(sources.data?.sources ?? []).length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No sources configured. Add one to start collecting.
                </p>
              ) : (
                <ul className="mb-4 space-y-2">
                  {(sources.data?.sources ?? []).map((source) => (
                    <li
                      key={source.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 p-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge tone={statusTone(source.status)}>{source.type}</Badge>
                          <p className="truncate text-sm font-medium">{source.name}</p>
                        </div>
                        {source.unavailableReason ? (
                          <p className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                            {source.unavailableReason}
                          </p>
                        ) : (
                          <p className="tabular mt-1 text-xs text-muted-foreground">
                            {source.lastRunAt
                              ? `last run ${relativeTime(source.lastRunAt)} · ${source.lastItemCount} items`
                              : 'never run'}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteSource.mutate(source.id)}
                        aria-label={`Delete ${source.name}`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Availability of every source type this build supports. */}
              <div className="border-t border-border/50 pt-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Source types on this deployment
                </p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {(sources.data?.sourceTypes ?? []).map((type) => (
                    <li
                      key={type.type}
                      className="rounded-lg border border-border/40 p-2.5 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <Badge tone={type.available ? 'success' : 'neutral'}>
                          {type.available ? 'available' : 'unavailable'}
                        </Badge>
                        <span className="font-medium">{type.type}</span>
                      </div>
                      {type.reason ? (
                        <p className="mt-1 text-muted-foreground">{type.reason}</p>
                      ) : null}
                      {type.requiredVariables && type.requiredVariables.length > 0 ? (
                        <p className="tabular mt-1 text-accent">
                          {type.requiredVariables.join(', ')}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Collected items */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Collected items</CardTitle>
          <div className="relative w-56">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search collected research"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </CardHeader>
        <CardContent>
          {items.isLoading ? (
            <Skeleton className="h-48" />
          ) : items.error ? (
            <ErrorState error={items.error} onRetry={() => void items.refetch()} />
          ) : (items.data?.items ?? []).length === 0 ? (
            <EmptyState
              icon={<Search className="h-8 w-8" />}
              title="Nothing collected yet"
              description="Run research to collect from your configured sources."
            />
          ) : (
            <ul className="divide-y divide-border/50">
              {(items.data?.items ?? []).map((item) => (
                <li key={item.id} className="py-3 first:pt-0">
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
                        {item.author ? ` · ${item.author}` : ''} · collected{' '}
                        {relativeTime(item.collectedAt)}
                      </p>
                    </div>
                    {Object.keys(item.engagement).length > 0 ? (
                      <p className="tabular shrink-0 text-xs text-muted-foreground">
                        {Object.entries(item.engagement)
                          .slice(0, 2)
                          .map(([key, value]) => `${key} ${value}`)
                          .join(' · ')}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AddSourceModal open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

/**
 * Adds a source. Config is per-adapter, so the form changes shape with the type
 * rather than presenting one generic JSON box.
 */
function AddSourceModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createSource = useCreateResearchSource();
  const [type, setType] = useState<string>('RSS');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  const configField = {
    RSS: { label: 'Feed URLs', hint: 'Comma separated.', key: 'feedUrls', list: true },
    NEWS: { label: 'Feed URLs', hint: 'Comma separated news feeds.', key: 'feedUrls', list: true },
    REDDIT: { label: 'Subreddits', hint: 'Comma separated, without r/.', key: 'subreddits', list: true },
    YOUTUBE: { label: 'Search queries', hint: 'Comma separated.', key: 'queries', list: true },
    X: { label: 'Search queries', hint: 'Comma separated.', key: 'queries', list: true },
    WEB: { label: 'Search queries', hint: 'Comma separated.', key: 'queries', list: true },
    CUSTOM_URL: { label: 'Page URLs', hint: 'Comma separated.', key: 'urls', list: true },
    GOOGLE_TRENDS: { label: 'Not configurable', hint: '', key: 'unused', list: false },
  }[type] ?? { label: 'Configuration', hint: '', key: 'queries', list: true };

  function handleSubmit(): void {
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    createSource.mutate(
      {
        type,
        name: name.trim(),
        config: configField.list ? { [configField.key]: entries } : {},
      },
      {
        onSuccess: () => {
          setName('');
          setValue('');
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add a research source"
      description="A source with missing credentials is still saved, but marked unavailable with the reason."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={createSource.isPending}
            disabled={name.trim().length === 0}
          >
            Add source
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Type">
          <Select value={type} onChange={(event) => setType(event.target.value)}>
            {RESEARCH_SOURCE_TYPES.map((sourceType) => (
              <option key={sourceType} value={sourceType}>
                {sourceType}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Web3 gaming news"
          />
        </Field>
        {configField.list ? (
          <Field label={configField.label} hint={configField.hint}>
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                type === 'REDDIT' ? 'gamedev, web3, MachineLearning' : 'https://example.com/feed.xml'
              }
            />
          </Field>
        ) : (
          <p className="rounded-lg border border-border/60 bg-surface-raised/40 p-3 text-xs text-muted-foreground">
            Google does not offer an official public Trends API, so this source cannot be
            collected. It appears in the list so the limitation is visible.
          </p>
        )}
      </div>
    </Modal>
  );
}
