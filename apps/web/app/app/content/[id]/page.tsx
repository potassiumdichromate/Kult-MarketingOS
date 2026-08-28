'use client';

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  History,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getCapability, countCharacters, validateContent } from '@kult/shared';
import {
  useAssistContent,
  useContentAction,
  useContentItem,
  useContentVersions,
  useDeleteContent,
  useGenerateContent,
  useOrganization,
  useUpdateContent,
} from '@/lib/queries';
import { formatContentType, formatInTimezone, relativeTime } from '@/lib/format';
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
  Skeleton,
  Textarea,
  cn,
  statusTone,
} from '@/components/ui';

/**
 * Content studio.
 *
 * The editor is deliberately opinionated about two things:
 *
 *  - Platform limits are enforced live, using the same validation the API and
 *    worker run, so a piece cannot reach approval in a shape that will fail.
 *  - Factual claims are shown with their verification state. An unverified claim
 *    is the single most common reason a piece needs human review, so it is
 *    surfaced next to the copy rather than buried.
 */
export default function ContentStudioPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const content = useContentItem(params.id);
  const versions = useContentVersions(params.id);
  const organization = useOrganization();
  const updateContent = useUpdateContent(params.id);
  const generate = useGenerateContent(params.id);
  const assist = useAssistContent(params.id);
  const action = useContentAction(params.id);
  const deleteContent = useDeleteContent();

  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [cta, setCta] = useState('');
  const [dirty, setDirty] = useState(false);

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [assistResult, setAssistResult] = useState<Record<string, unknown> | null>(null);
  const [scheduledAt, setScheduledAt] = useState('');
  const [rejectComment, setRejectComment] = useState('');

  const data = content.data;

  // Load server state into the editor whenever a new version arrives.
  useEffect(() => {
    if (!data) return;
    setBody(data.body);
    setTitle(data.title ?? '');
    setHashtags(data.hashtags.join(', '));
    setCta(data.cta ?? '');
    setDirty(false);
  }, [data?.id, data?.version]);

  if (content.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (content.error) {
    return <ErrorState error={content.error} onRetry={() => void content.refetch()} />;
  }
  if (!data) return null;

  const capability = getCapability(data.contentType);
  const characterCount = countCharacters(body);
  const overLimit = characterCount > capability.maxCharacters.value;

  const hashtagList = hashtags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  const violations = validateContent({
    contentType: data.contentType,
    body,
    hashtags: hashtagList,
    threadParts: data.threadParts,
    mediaCount: data.mediaAssets.length,
  });

  const unverifiedClaims = data.factualClaims.filter((claim) => !claim.verified);
  const editable = data.status !== 'PUBLISHED' && data.status !== 'PUBLISHING';

  function save(): void {
    updateContent.mutate(
      {
        body,
        title: title.trim() || null,
        hashtags: hashtagList,
        cta: cta.trim() || null,
      },
      { onSuccess: () => setDirty(false) },
    );
  }

  return (
    <div className="animate-fade-in space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/app/content"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          All content
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(data.status)}>{data.status.replace(/_/g, ' ')}</Badge>
          <Badge>{formatContentType(data.contentType)}</Badge>
          <span className="tabular text-xs text-muted-foreground">version {data.version}</span>
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <History className="h-3.5 w-3.5" aria-hidden />
            History
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Editor */}
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 pt-5">
              <Field label="Title" hint="Internal only. Not published.">
                <Input
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setDirty(true);
                  }}
                  disabled={!editable}
                  placeholder="Working title"
                />
              </Field>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm font-medium">Body</span>
                  <span
                    className={cn(
                      'tabular text-xs',
                      overLimit ? 'font-medium text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    {characterCount} / {capability.maxCharacters.value}
                  </span>
                </div>
                <Textarea
                  value={body}
                  onChange={(event) => {
                    setBody(event.target.value);
                    setDirty(true);
                  }}
                  disabled={!editable}
                  className={cn('min-h-56 font-sans', overLimit && 'border-destructive')}
                  placeholder="Write the post, or generate a draft from the brief."
                />
                {capability.maxCharacters.provenance === 'app-policy' ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {capability.maxCharacters.note ??
                      'This limit is enforced by Kult Marketing OS rather than published by the platform.'}
                  </p>
                ) : null}
              </div>

              {data.threadParts.length > 0 ? (
                <div>
                  <p className="mb-2 text-sm font-medium">Thread ({data.threadParts.length} posts)</p>
                  <ol className="space-y-2">
                    {data.threadParts.map((part, index) => {
                      const partCount = countCharacters(part);
                      return (
                        <li
                          key={index}
                          className="rounded-lg border border-border/50 bg-surface-raised/30 p-3"
                        >
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">
                              Post {index + 1}
                            </span>
                            <span
                              className={cn(
                                'tabular text-xs',
                                partCount > capability.maxCharacters.value
                                  ? 'text-destructive'
                                  : 'text-muted-foreground',
                              )}
                            >
                              {partCount} / {capability.maxCharacters.value}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap text-sm">{part}</p>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Hashtags"
                  hint={`Comma separated. Max ${capability.maxHashtags.value}.`}
                  error={
                    hashtagList.length > capability.maxHashtags.value
                      ? `${hashtagList.length} hashtags exceeds the limit.`
                      : undefined
                  }
                >
                  <Input
                    value={hashtags}
                    onChange={(event) => {
                      setHashtags(event.target.value);
                      setDirty(true);
                    }}
                    disabled={!editable}
                    placeholder="web3gaming, aiagents"
                  />
                </Field>
                <Field label="Call to action">
                  <Input
                    value={cta}
                    onChange={(event) => {
                      setCta(event.target.value);
                      setDirty(true);
                    }}
                    disabled={!editable}
                    placeholder="Try it at app.kult.games"
                  />
                </Field>
              </div>

              {violations.length > 0 ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                  <p className="text-sm font-medium text-destructive">Platform violations</p>
                  <ul className="mt-1 space-y-0.5">
                    {violations.map((violation, index) => (
                      <li key={index} className="text-xs text-muted-foreground">
                        {violation.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {editable ? (
                <div className="flex flex-wrap gap-2 border-t border-border/50 pt-4">
                  <Button variant="primary" onClick={save} loading={updateContent.isPending} disabled={!dirty}>
                    {dirty ? 'Save changes' : 'Saved'}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => generate.mutate({ brief: body || title })}
                    loading={generate.isPending}
                  >
                    <Sparkles className="h-4 w-4" aria-hidden />
                    Generate
                  </Button>
                  {(['SHORTEN', 'EXPAND', 'REWRITE'] as const).map((operation) => (
                    <Button
                      key={operation}
                      variant="ghost"
                      size="sm"
                      loading={assist.isPending && assist.variables?.operation === operation}
                      onClick={() =>
                        assist.mutate(
                          { operation },
                          { onSuccess: (result) => setAssistResult(result) },
                        )
                      }
                    >
                      {operation.charAt(0) + operation.slice(1).toLowerCase()}
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={assist.isPending && assist.variables?.operation === 'FACT_CHECK'}
                    onClick={() =>
                      assist.mutate(
                        { operation: 'FACT_CHECK' },
                        { onSuccess: (result) => setAssistResult(result) },
                      )
                    }
                  >
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                    Fact check
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={assist.isPending && assist.variables?.operation === 'BRAND_CHECK'}
                    onClick={() =>
                      assist.mutate(
                        { operation: 'BRAND_CHECK' },
                        { onSuccess: (result) => setAssistResult(result) },
                      )
                    }
                  >
                    Brand check
                  </Button>
                </div>
              ) : (
                <p className="rounded-lg border border-border/60 bg-surface-raised/40 p-3 text-sm text-muted-foreground">
                  {data.status === 'PUBLISHED'
                    ? 'Published content cannot be edited. Duplicate it to make a new version.'
                    : 'This content is currently publishing and cannot be edited.'}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Assist output */}
          {assistResult ? (
            <Card className="border-accent/40">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>AI suggestion</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setAssistResult(null)}>
                  Dismiss
                </Button>
              </CardHeader>
              <CardContent>
                <AssistOutput
                  result={assistResult}
                  onApply={(nextBody) => {
                    setBody(nextBody);
                    setDirty(true);
                    setAssistResult(null);
                  }}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Lifecycle */}
          <Card>
            <CardHeader>
              <CardTitle>Workflow</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.status === 'DRAFT' ? (
                <Button
                  variant="primary"
                  className="w-full"
                  onClick={() => action.mutate({ action: 'submit' })}
                  loading={action.isPending}
                >
                  <Send className="h-4 w-4" aria-hidden />
                  Submit for approval
                </Button>
              ) : null}

              {data.status === 'PENDING_APPROVAL' ? (
                <>
                  <Button
                    variant="primary"
                    className="w-full"
                    onClick={() => action.mutate({ action: 'approve' })}
                    loading={action.isPending}
                    disabled={violations.length > 0}
                  >
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                    Approve
                  </Button>
                  <Button variant="secondary" className="w-full" onClick={() => setRejectOpen(true)}>
                    <XCircle className="h-4 w-4" aria-hidden />
                    Reject
                  </Button>
                  {violations.length > 0 ? (
                    <p className="text-xs text-destructive">
                      Fix the platform violations before approving.
                    </p>
                  ) : null}
                </>
              ) : null}

              {data.status === 'APPROVED' || data.status === 'SCHEDULED' ? (
                <>
                  <Button
                    variant="primary"
                    className="w-full"
                    onClick={() => action.mutate({ action: 'publish' })}
                    loading={action.isPending}
                  >
                    <Send className="h-4 w-4" aria-hidden />
                    Publish now
                  </Button>
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={() => setScheduleOpen(true)}
                  >
                    <Clock className="h-4 w-4" aria-hidden />
                    {data.status === 'SCHEDULED' ? 'Reschedule' : 'Schedule'}
                  </Button>
                  <Button
                    variant="ghost"
                    className="w-full"
                    onClick={() => action.mutate({ action: 'cancel' })}
                  >
                    Cancel
                  </Button>
                </>
              ) : null}

              {data.status === 'FAILED' ? (
                <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-muted-foreground">
                  The last publish attempt failed. Check the publication log below before retrying —
                  if delivery could not be confirmed, verify the account first so the post is not
                  published twice.
                </p>
              ) : null}

              {editable ? (
                <Button
                  variant="ghost"
                  className="w-full text-destructive"
                  onClick={() =>
                    deleteContent.mutate(params.id, {
                      onSuccess: () => router.push('/app/content'),
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  Delete
                </Button>
              ) : null}
            </CardContent>
          </Card>

          {/* Claims */}
          <Card className={unverifiedClaims.length > 0 ? 'border-warning/40' : undefined}>
            <CardHeader>
              <CardTitle>Factual claims</CardTitle>
            </CardHeader>
            <CardContent>
              {data.factualClaims.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No factual claims recorded for this content.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.factualClaims.map((claim, index) => (
                    <li key={index} className="rounded-lg border border-border/50 p-2.5">
                      <div className="flex items-start gap-2">
                        {claim.verified ? (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                        ) : (
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                        )}
                        <div className="min-w-0">
                          <p className="text-xs">{claim.claim}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {claim.verified
                              ? 'Matches an approved claim.'
                              : 'Not backed by an approved claim — needs review before publishing.'}
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {unverifiedClaims.length > 0 ? (
                <Link href="/app/knowledge" className="mt-3 block text-xs text-accent hover:underline">
                  Add an approved claim →
                </Link>
              ) : null}
            </CardContent>
          </Card>

          {/* Risk */}
          {data.riskLevel !== 'LOW' || data.flaggedTopics.length > 0 ? (
            <Card className="border-warning/40">
              <CardHeader>
                <CardTitle>Review required</CardTitle>
              </CardHeader>
              <CardContent>
                <Badge tone={statusTone(data.riskLevel)}>{data.riskLevel} risk</Badge>
                {data.flaggedTopics.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {data.flaggedTopics.map((topic) => (
                      <Badge key={topic} tone="warning">
                        {topic.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                  Flagged topics always require human approval and can never be published by
                  autopilot.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {/* Publications */}
          {data.publications.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Publications</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {data.publications.map((publication) => (
                    <li key={publication.id} className="rounded-lg border border-border/50 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone={statusTone(publication.status)}>{publication.provider}</Badge>
                        <span className="tabular text-xs text-muted-foreground">
                          {publication.attempts} attempt{publication.attempts === 1 ? '' : 's'}
                        </span>
                      </div>
                      {publication.providerUrl ? (
                        <a
                          href={publication.providerUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mt-1 block text-xs text-accent hover:underline"
                        >
                          View published post
                        </a>
                      ) : null}
                      {publication.errorMessage ? (
                        <p className="mt-1 text-xs text-destructive">
                          {publication.errorCode === 'AMBIGUOUS_DELIVERY'
                            ? 'Delivery could not be confirmed. Check the account before retrying.'
                            : publication.errorMessage}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {/* Approvals */}
          {data.approvals.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Approval history</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {data.approvals.map((approval) => (
                    <li key={approval.id} className="text-xs">
                      <div className="flex items-center gap-2">
                        <Badge tone={statusTone(approval.decision)}>{approval.decision}</Badge>
                        <span className="text-muted-foreground">
                          {approval.reviewer.displayName ?? approval.reviewer.email}
                        </span>
                      </div>
                      {approval.comment ? (
                        <p className="mt-1 text-muted-foreground">{approval.comment}</p>
                      ) : null}
                      <p className="tabular mt-0.5 text-muted-foreground/70">
                        {relativeTime(approval.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {/* Schedule */}
      <Modal
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        title="Schedule publication"
        description={`Times are entered in your browser timezone and stored in UTC. The organization timezone is ${organization.data?.timezone ?? 'UTC'}.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setScheduleOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={action.isPending}
              disabled={!scheduledAt}
              onClick={() =>
                action.mutate(
                  {
                    action: 'schedule',
                    body: { scheduledAt: new Date(scheduledAt).toISOString() },
                  },
                  { onSuccess: () => setScheduleOpen(false) },
                )
              }
            >
              Schedule
            </Button>
          </>
        }
      >
        <Field label="Publish at">
          <Input
            type="datetime-local"
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
          />
        </Field>
      </Modal>

      {/* Reject */}
      <Modal
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title="Reject this content"
        description="A comment is required so the author knows what to change."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={action.isPending}
              disabled={rejectComment.trim().length === 0}
              onClick={() =>
                action.mutate(
                  { action: 'reject', body: { comment: rejectComment.trim() } },
                  {
                    onSuccess: () => {
                      setRejectOpen(false);
                      setRejectComment('');
                    },
                  },
                )
              }
            >
              Reject
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea
            value={rejectComment}
            onChange={(event) => setRejectComment(event.target.value)}
            placeholder="What needs to change before this can be approved?"
          />
        </Field>
      </Modal>

      {/* Version history */}
      <Modal
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        title="Version history"
        description="Every substantive edit creates a version. The version is part of the publishing idempotency key."
      >
        {versions.isLoading ? (
          <Skeleton className="h-32" />
        ) : (
          <ul className="space-y-3">
            {(versions.data ?? []).map((version) => (
              <li key={version.id} className="rounded-lg border border-border/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="tabular text-sm font-medium">v{version.version}</span>
                  <span className="text-xs text-muted-foreground">
                    {version.createdByAgent ?? version.createdBy?.displayName ?? 'Unknown'} ·{' '}
                    {relativeTime(version.createdAt)}
                  </span>
                </div>
                {version.changeSummary ? (
                  <p className="mt-1 text-xs text-accent">{version.changeSummary}</p>
                ) : null}
                <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                  {version.body.slice(0, 400)}
                  {version.body.length > 400 ? '…' : ''}
                </p>
                {version.rationale ? (
                  <p className="mt-2 border-t border-border/40 pt-2 text-xs text-muted-foreground">
                    <span className="font-medium">Why: </span>
                    {version.rationale}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}

/**
 * Renders whichever assist operation ran. The shapes differ per operation, so
 * this narrows on the fields present rather than taking a discriminator.
 */
function AssistOutput({
  result,
  onApply,
}: {
  result: Record<string, unknown>;
  onApply: (body: string) => void;
}) {
  if (typeof result.body === 'string') {
    return (
      <div>
        {typeof result.changeSummary === 'string' ? (
          <p className="mb-2 text-xs text-accent">{result.changeSummary}</p>
        ) : null}
        <p className="whitespace-pre-wrap rounded-lg border border-border/50 bg-surface-raised/40 p-3 text-sm">
          {result.body}
        </p>
        <Button variant="primary" size="sm" className="mt-3" onClick={() => onApply(result.body as string)}>
          Use this version
        </Button>
      </div>
    );
  }

  if (Array.isArray(result.claims)) {
    return (
      <ul className="space-y-2">
        {(result.claims as Array<{ claim: string; verdict: string; recommendation: string }>).map(
          (claim, index) => (
            <li key={index} className="rounded-lg border border-border/50 p-2.5">
              <Badge tone={claim.verdict === 'SUPPORTED' ? 'success' : 'warning'}>
                {claim.verdict}
              </Badge>
              <p className="mt-1 text-xs">{claim.claim}</p>
              <p className="mt-1 text-xs text-muted-foreground">{claim.recommendation}</p>
            </li>
          ),
        )}
      </ul>
    );
  }

  if (Array.isArray(result.violations)) {
    const violations = result.violations as Array<{
      rule: string;
      excerpt: string;
      suggestion: string;
    }>;
    return violations.length === 0 ? (
      <p className="text-sm text-success">No brand guideline violations found.</p>
    ) : (
      <ul className="space-y-2">
        {violations.map((violation, index) => (
          <li key={index} className="rounded-lg border border-warning/40 bg-warning/5 p-2.5">
            <p className="text-xs font-medium">{violation.rule}</p>
            <p className="mt-1 text-xs text-muted-foreground">&ldquo;{violation.excerpt}&rdquo;</p>
            <p className="mt-1 text-xs text-accent">{violation.suggestion}</p>
          </li>
        ))}
      </ul>
    );
  }

  if (Array.isArray(result.hooks)) {
    return (
      <ul className="space-y-2">
        {(result.hooks as Array<{ hook: string; rationale: string }>).map((hook, index) => (
          <li key={index} className="rounded-lg border border-border/50 p-2.5">
            <p className="text-sm">{hook.hook}</p>
            <p className="mt-1 text-xs text-muted-foreground">{hook.rationale}</p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <pre className="tabular overflow-x-auto rounded-lg bg-surface-sunken p-3 text-xs">
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}
