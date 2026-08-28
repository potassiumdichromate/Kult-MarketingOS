'use client';

import { BookOpen, CheckCircle2, Link2, Plus, ShieldOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  useCreateKnowledgeEntity,
  useDeleteKnowledgeEntity,
  useIngestKnowledge,
  useKnowledge,
} from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  statusTone,
} from '@/components/ui';

type EntityKind =
  | 'PRODUCT'
  | 'AUDIENCE'
  | 'COMPETITOR'
  | 'APPROVED_CLAIM'
  | 'FORBIDDEN_CLAIM'
  | 'GUIDELINE';

/**
 * Brand knowledge base.
 *
 * This is what the AI is allowed to assert. Approved claims are the load-bearing
 * part: a generated factual statement that does not match one is flagged for
 * review and can never be published by autopilot, so an empty approved-claims
 * list produces cautious content rather than invented content.
 */
export default function KnowledgePage() {
  const knowledge = useKnowledge();
  const createEntity = useCreateKnowledgeEntity();
  const deleteEntity = useDeleteKnowledgeEntity();
  const ingest = useIngestKnowledge();

  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<EntityKind>('APPROVED_CLAIM');
  const [ingestOpen, setIngestOpen] = useState(false);

  if (knowledge.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (knowledge.error) {
    return <ErrorState error={knowledge.error} onRetry={() => void knowledge.refetch()} />;
  }

  const data = knowledge.data;
  if (!data) return null;

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="Brand knowledge"
        description={`What the AI is allowed to say about Kult. ${data.indexedChunks} indexed chunks are searchable during generation.`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setIngestOpen(true)}>
              <Link2 className="h-4 w-4" aria-hidden />
              Add source
            </Button>
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Add entry
            </Button>
          </>
        }
      />

      {data.approvedClaims.length === 0 ? (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="pt-5">
            <p className="text-sm font-medium text-warning">No approved claims recorded</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Until you add some, the AI is instructed not to assert any specific fact about
              Kult — no statistics, user numbers, partnerships or token economics. It will write
              about topics and positioning without making factual claims.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Approved claims */}
        <Card>
          <CardHeader>
            <CardTitle>Approved claims ({data.approvedClaims.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {data.approvedClaims.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.approvedClaims.map((claim) => (
                  <li
                    key={claim.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-border/50 p-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                        <p className="text-sm">{claim.claim}</p>
                      </div>
                      {claim.evidenceUrl ? (
                        <a
                          href={claim.evidenceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mt-1 block pl-5 text-xs text-accent hover:underline"
                        >
                          Evidence
                        </a>
                      ) : null}
                      {claim.expiresAt ? (
                        <p className="mt-1 pl-5 text-xs text-warning">
                          expires {relativeTime(claim.expiresAt)}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete claim"
                      onClick={() =>
                        deleteEntity.mutate({ type: 'APPROVED_CLAIM', id: claim.id })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Forbidden claims */}
        <Card>
          <CardHeader>
            <CardTitle>Forbidden claims ({data.forbiddenClaims.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {data.forbiddenClaims.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Nothing explicitly forbidden.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.forbiddenClaims.map((claim) => (
                  <li
                    key={claim.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-start gap-2">
                        <ShieldOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
                        <p className="text-sm">{claim.claim}</p>
                      </div>
                      <p className="mt-1 pl-5 text-xs text-muted-foreground">{claim.reason}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete forbidden claim"
                      onClick={() =>
                        deleteEntity.mutate({ type: 'FORBIDDEN_CLAIM', id: claim.id })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Products */}
        <Card>
          <CardHeader>
            <CardTitle>Products ({data.products.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {data.products.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.products.map((product) => (
                  <li
                    key={product.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-border/50 p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{product.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{product.description}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete product"
                      onClick={() => deleteEntity.mutate({ type: 'PRODUCT', id: product.id })}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Audiences */}
        <Card>
          <CardHeader>
            <CardTitle>Audiences ({data.audiences.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {data.audiences.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.audiences.map((audience) => (
                  <li
                    key={audience.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-border/50 p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{audience.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{audience.description}</p>
                      {audience.painPoints.length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {audience.painPoints.map((point) => (
                            <Badge key={point}>{point}</Badge>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete audience"
                      onClick={() => deleteEntity.mutate({ type: 'AUDIENCE', id: audience.id })}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Documents */}
      <Card>
        <CardHeader>
          <CardTitle>Indexed sources ({data.documents.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {data.documents.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No documents or pages indexed yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.documents.map((document) => (
                <li
                  key={document.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <p className="truncate text-sm font-medium">{document.title}</p>
                      <Badge tone={statusTone(document.status)}>{document.status}</Badge>
                    </div>
                    <p className="tabular mt-0.5 pl-5 text-xs text-muted-foreground">
                      {document.sourceType} · {document.chunkCount} chunks ·{' '}
                      {document.extractedChars.toLocaleString()} characters
                    </p>
                    {document.error ? (
                      <p className="mt-1 pl-5 text-xs text-destructive">{document.error}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AddEntryModal
        open={addOpen}
        onOpenChange={setAddOpen}
        kind={addKind}
        onKindChange={setAddKind}
        onSubmit={(body) => createEntity.mutate(body, { onSuccess: () => setAddOpen(false) })}
        pending={createEntity.isPending}
      />

      <Modal
        open={ingestOpen}
        onOpenChange={setIngestOpen}
        title="Add a knowledge source"
        description="A public URL is fetched, extracted and embedded. Free text is indexed immediately."
      >
        <IngestForm
          onSubmit={(kind, body) =>
            ingest.mutate({ kind, body }, { onSuccess: () => setIngestOpen(false) })
          }
          pending={ingest.isPending}
        />
      </Modal>
    </div>
  );
}

function AddEntryModal({
  open,
  onOpenChange,
  kind,
  onKindChange,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: EntityKind;
  onKindChange: (kind: EntityKind) => void;
  onSubmit: (body: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = (key: string, value: string): void =>
    setFields((current) => ({ ...current, [key]: value }));

  function submit(): void {
    const trimmed = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, value.trim()]),
    );
    onSubmit({ type: kind, ...trimmed });
    setFields({});
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add a knowledge entry"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Type">
          <Select value={kind} onChange={(event) => onKindChange(event.target.value as EntityKind)}>
            <option value="APPROVED_CLAIM">Approved claim</option>
            <option value="FORBIDDEN_CLAIM">Forbidden claim</option>
            <option value="PRODUCT">Product</option>
            <option value="AUDIENCE">Audience</option>
            <option value="COMPETITOR">Competitor</option>
            <option value="GUIDELINE">Brand guideline</option>
          </Select>
        </Field>

        {kind === 'APPROVED_CLAIM' ? (
          <>
            <Field
              label="Claim"
              required
              hint="A factual statement the AI may assert. Write it exactly as it should be said."
            >
              <Textarea value={fields.claim ?? ''} onChange={(e) => set('claim', e.target.value)} />
            </Field>
            <Field label="Evidence URL" hint="Optional. Where this can be verified.">
              <Input value={fields.evidenceUrl ?? ''} onChange={(e) => set('evidenceUrl', e.target.value)} />
            </Field>
          </>
        ) : null}

        {kind === 'FORBIDDEN_CLAIM' ? (
          <>
            <Field label="Phrase or claim" required>
              <Textarea value={fields.claim ?? ''} onChange={(e) => set('claim', e.target.value)} />
            </Field>
            <Field label="Reason" required hint="Shown when content is blocked for using it.">
              <Input value={fields.reason ?? ''} onChange={(e) => set('reason', e.target.value)} />
            </Field>
          </>
        ) : null}

        {kind === 'PRODUCT' || kind === 'AUDIENCE' ? (
          <>
            <Field label="Name" required>
              <Input value={fields.name ?? ''} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Description" required>
              <Textarea
                value={fields.description ?? ''}
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>
          </>
        ) : null}

        {kind === 'COMPETITOR' ? (
          <>
            <Field label="Name" required>
              <Input value={fields.name ?? ''} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Website">
              <Input value={fields.websiteUrl ?? ''} onChange={(e) => set('websiteUrl', e.target.value)} />
            </Field>
          </>
        ) : null}

        {kind === 'GUIDELINE' ? (
          <>
            <Field label="Category" required>
              <Input
                value={fields.category ?? ''}
                onChange={(e) => set('category', e.target.value)}
                placeholder="Tone"
              />
            </Field>
            <Field label="Rule" required>
              <Textarea value={fields.rule ?? ''} onChange={(e) => set('rule', e.target.value)} />
            </Field>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function IngestForm({
  onSubmit,
  pending,
}: {
  onSubmit: (kind: 'url' | 'text', body: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [mode, setMode] = useState<'url' | 'text'>('url');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');

  return (
    <div className="space-y-4">
      <Field label="Source">
        <Select value={mode} onChange={(event) => setMode(event.target.value as 'url' | 'text')}>
          <option value="url">Public URL</option>
          <option value="text">Paste text</option>
        </Select>
      </Field>

      {mode === 'url' ? (
        <Field
          label="URL"
          required
          hint="Fetched through the SSRF-guarded client; private and internal addresses are rejected."
        >
          <Input value={url} onChange={(event) => setUrl(event.target.value)} type="url" />
        </Field>
      ) : (
        <>
          <Field label="Title" required>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Text" required>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="min-h-40"
            />
          </Field>
        </>
      )}

      <Button
        variant="primary"
        className="w-full"
        loading={pending}
        disabled={mode === 'url' ? !url.trim() : !title.trim() || text.trim().length < 20}
        onClick={() =>
          mode === 'url'
            ? onSubmit('url', { url: url.trim() })
            : onSubmit('text', { title: title.trim(), text: text.trim() })
        }
      >
        Add and index
      </Button>
    </div>
  );
}
