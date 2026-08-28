'use client';

import { AlertTriangle, FileText, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CONTENT_STATUSES, CONTENT_TYPES } from '@kult/shared';
import { useContentList, useCreateContent, useOrganization } from '@/lib/queries';
import { formatContentType, formatInTimezone, relativeTime, truncate } from '@/lib/format';
import type { ContentStatus } from '@/lib/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
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

export default function ContentPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <ContentList />
    </Suspense>
  );
}

/**
 * Content list.
 *
 * Status drives everything here, because the approval pipeline is the product's
 * spine: a piece is a draft, waiting on a human, scheduled, live, or broken.
 */
function ContentList() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialStatus = (searchParams.get('status') ?? '') as ContentStatus | '';

  const [status, setStatus] = useState<ContentStatus | ''>(initialStatus);
  const [createOpen, setCreateOpen] = useState(false);

  const organization = useOrganization();
  const content = useContentList({ ...(status ? { status } : {}), limit: 60 });

  const items = content.data?.items ?? [];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Content"
        description="Every draft, approval, schedule and publication, with the version that was approved."
        actions={
          <>
            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value as ContentStatus | '')}
              className="w-48"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {CONTENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New content
            </Button>
          </>
        }
      />

      {content.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : content.error ? (
        <ErrorState error={content.error} onRetry={() => void content.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-8 w-8" />}
          title={status ? `No ${status.replace(/_/g, ' ').toLowerCase()} content` : 'No content yet'}
          description="Create a draft directly, or convert an opportunity into one so the post keeps its provenance."
          action={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              Create the first draft
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/app/content/${item.id}`}
                className="block rounded-xl border border-border/50 bg-surface/40 p-4 transition-colors hover:border-border-strong"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={statusTone(item.status)}>{item.status.replace(/_/g, ' ')}</Badge>
                      <Badge>{formatContentType(item.contentType)}</Badge>
                      {item.riskLevel !== 'LOW' ? (
                        <Badge tone={statusTone(item.riskLevel)}>
                          <AlertTriangle className="h-3 w-3" aria-hidden />
                          {item.riskLevel}
                        </Badge>
                      ) : null}
                      {item.createdByAgent ? <Badge tone="accent">AI drafted</Badge> : null}
                      <span className="tabular text-xs text-muted-foreground">v{item.version}</span>
                    </div>

                    <p className="text-sm font-medium">
                      {item.title ?? (truncate(item.body, 90) || 'Untitled draft')}
                    </p>
                    {item.title ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {truncate(item.body, 140)}
                      </p>
                    ) : null}
                  </div>

                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    {item.publishedAt ? (
                      <p className="tabular">
                        published{' '}
                        {formatInTimezone(item.publishedAt, organization.data?.timezone)}
                      </p>
                    ) : item.scheduledAt ? (
                      <p className="tabular text-accent">
                        scheduled{' '}
                        {formatInTimezone(item.scheduledAt, organization.data?.timezone)}
                      </p>
                    ) : (
                      <p>edited {relativeTime(item.updatedAt)}</p>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <CreateContentModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => router.push(`/app/content/${id}`)}
      />
    </div>
  );
}

function CreateContentModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const createContent = useCreateContent();
  const [contentType, setContentType] = useState('X_POST');
  const [brief, setBrief] = useState('');

  function handleSubmit(): void {
    createContent.mutate(
      { contentType, body: brief.trim(), title: truncate(brief.trim(), 120) },
      {
        onSuccess: (draft) => {
          onOpenChange(false);
          setBrief('');
          onCreated((draft as { id: string }).id);
        },
      },
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New content"
      description="Start with a brief. You can generate the copy from it in the studio."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={createContent.isPending}
            disabled={brief.trim().length < 3}
          >
            Create draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Content type">
          <Select value={contentType} onChange={(event) => setContentType(event.target.value)}>
            {CONTENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {formatContentType(type)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Brief" hint="What this post should be about.">
          <Input
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="Why AI agents make better game characters than scripted NPCs"
          />
        </Field>
      </div>
    </Modal>
  );
}
