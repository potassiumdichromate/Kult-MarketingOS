import type { Job } from 'bullmq';
import { ProviderError, RateLimitError } from '@kult/shared';
import {
  QUEUE_NAMES,
  canTransition,
  evaluateAutopilotEligibility,
  getCapability,
  publishingIdempotencyKey,
  publishingLockKey,
  validateContent,
  type ApprovalTopic,
} from '@kult/shared';
import { sanitizeProviderMessage, type PublishInput } from '@kult/integrations';
import type { WorkerContext } from '../context.js';
import { JOB_NAMES, publishContentJob, type PublishContentJob } from '../jobs.js';
import { loadConnectionWithValidToken } from '../lib/connections.js';
import { withLock } from '../lib/lock.js';
import { audit, notify } from '../lib/notify.js';
import type { JobLogger } from '../logger.js';

/**
 * Publishing.
 *
 * This is the one place in the system that posts publicly, so the guarantee it
 * must uphold is narrow and absolute: **the same content version is never
 * published twice.** Three mechanisms combine to enforce it.
 *
 * 1. Idempotency key - sha256(org, connection, content, contentVersion). A
 *    Publication row is keyed on it with a unique constraint. A SUCCEEDED row
 *    short-circuits immediately, so a duplicate job, a duplicate click, or a
 *    BullMQ retry after a completed publish all become no-ops.
 *
 * 2. Distributed lock - two workers processing the same content concurrently
 *    cannot both reach the provider call.
 *
 * 3. Ambiguity quarantine - the hard case is a network timeout or 5xx *during*
 *    the provider call, where the post may or may not have been created. Since
 *    that cannot be resolved automatically, the publication is quarantined as
 *    NEEDS_VERIFICATION and never retried automatically. Silently retrying would
 *    risk a double post, which the specification forbids outright; a stalled
 *    publication a human can resolve is the strictly better failure.
 */

/** Lock lifetime. Instagram container processing can legitimately take a minute. */
const LOCK_TTL_MS = 5 * 60 * 1000;

/** Error code recorded when delivery could not be confirmed either way. */
const AMBIGUOUS = 'AMBIGUOUS_DELIVERY';

export async function processPublishContent(
  context: WorkerContext,
  job: Job,
  log: JobLogger,
): Promise<{ status: string; publicationId?: string; reason?: string }> {
  const payload = publishContentJob.parse(job.data);

  const idempotencyKey = publishingIdempotencyKey({
    organizationId: payload.organizationId,
    socialConnectionId: payload.socialConnectionId,
    contentItemId: payload.contentItemId,
    contentVersion: payload.contentVersion,
  });

  // Fast path before taking the lock: if this exact version already published,
  // there is nothing to do and nothing to coordinate.
  const settled = await findSettledPublication(context, idempotencyKey);
  if (settled) {
    log.info({ publicationId: settled.id, status: settled.status }, settled.message);
    return { status: settled.status, publicationId: settled.id, reason: settled.message };
  }

  const outcome = await withLock(
    context.redis,
    publishingLockKey(idempotencyKey),
    LOCK_TTL_MS,
    async (lock) => publishUnderLock(context, payload, idempotencyKey, log, lock),
  );

  if (!outcome.acquired) {
    // Another worker holds the lock and is publishing this right now. Returning
    // rather than throwing is deliberate: throwing would schedule a retry that
    // races the in-flight publish for no benefit.
    log.info({ contentItemId: payload.contentItemId }, 'Publish already in progress elsewhere');
    return { status: 'IN_PROGRESS_ELSEWHERE' };
  }

  return outcome.result;
}

/** Returns a description when a prior attempt already settled this key. */
async function findSettledPublication(
  context: WorkerContext,
  idempotencyKey: string,
): Promise<{ id: string; status: string; message: string } | null> {
  const existing = await context.prisma.publication.findUnique({
    where: { idempotencyKey },
    select: { id: true, status: true, errorCode: true, providerPostId: true },
  });
  if (!existing) return null;

  if (existing.status === 'SUCCEEDED') {
    return {
      id: existing.id,
      status: 'ALREADY_PUBLISHED',
      message: `This content version was already published (provider post ${existing.providerPostId}).`,
    };
  }

  // A quarantined publication must never be retried automatically.
  if (existing.status === 'FAILED' && existing.errorCode === AMBIGUOUS) {
    return {
      id: existing.id,
      status: 'NEEDS_VERIFICATION',
      message:
        'A previous attempt could not confirm whether the post was delivered. Check the account ' +
        'before retrying, to avoid publishing twice.',
    };
  }

  return null;
}

async function publishUnderLock(
  context: WorkerContext,
  payload: PublishContentJob,
  idempotencyKey: string,
  log: JobLogger,
  lock: { extend(ttlMs: number): Promise<boolean> },
): Promise<{ status: string; publicationId?: string; reason?: string }> {
  // Re-check inside the lock: another worker may have published while we waited.
  const settled = await findSettledPublication(context, idempotencyKey);
  if (settled) {
    return { status: settled.status, publicationId: settled.id, reason: settled.message };
  }

  const content = await context.prisma.contentItem.findUnique({
    where: { id: payload.contentItemId },
    select: {
      id: true,
      organizationId: true,
      contentType: true,
      status: true,
      version: true,
      body: true,
      threadParts: true,
      hashtags: true,
      riskLevel: true,
      flaggedTopics: true,
      factualClaims: true,
      mediaAssets: {
        orderBy: { order: 'asc' },
        select: {
          brandAsset: {
            select: { id: true, storageKey: true, mimeType: true, publicUrl: true, name: true },
          },
        },
      },
    },
  });

  if (!content || content.organizationId !== payload.organizationId) {
    // Tenant mismatch or deleted content: a permanent failure, never retried.
    return { status: 'SKIPPED', reason: 'The content item no longer exists.' };
  }

  if (content.status === 'PUBLISHED') {
    return { status: 'ALREADY_PUBLISHED', reason: 'Content is already marked published.' };
  }
  if (content.status === 'CANCELLED') {
    return { status: 'SKIPPED', reason: 'Content was cancelled before it published.' };
  }

  // The job carries the version it was queued for. If the content has since been
  // edited, this job is stale - publishing it would post copy nobody approved.
  if (content.version !== payload.contentVersion) {
    return {
      status: 'SKIPPED',
      reason:
        `Content was edited after this job was queued (queued v${payload.contentVersion}, ` +
        `current v${content.version}). The newer version must be approved and scheduled again.`,
    };
  }

  if (!canTransition(content.status, 'PUBLISHING')) {
    return {
      status: 'SKIPPED',
      reason: `Content in status ${content.status} is not publishable. It must be APPROVED or SCHEDULED.`,
    };
  }

  const capability = getCapability(content.contentType);
  if (!capability.publishable || !capability.provider) {
    return {
      status: 'UNSUPPORTED',
      reason: capability.requirement ?? `${content.contentType} cannot be published.`,
    };
  }

  // Platform constraints, enforced again at the boundary rather than trusted
  // from whatever the API checked when the job was queued.
  const violations = validateContent(
    {
      contentType: content.contentType,
      body: content.body,
      hashtags: content.hashtags,
      threadParts: content.threadParts,
      mediaCount: content.mediaAssets.length,
    },
    { forPublishing: true },
  );
  if (violations.length > 0) {
    const reason = violations.map((violation) => violation.message).join(' ');
    await failPermanently(context, payload, content.id, 'VALIDATION_FAILED', reason, log);
    return { status: 'FAILED', reason };
  }

  const connection = await loadConnectionWithValidToken(context, payload.socialConnectionId);
  if (connection.organizationId !== payload.organizationId) {
    return { status: 'SKIPPED', reason: 'The social connection belongs to another organization.' };
  }
  if (connection.status !== 'ACTIVE') {
    const reason = `The ${connection.provider} connection is ${connection.status} and cannot publish.`;
    await failPermanently(context, payload, content.id, 'CONNECTION_INACTIVE', reason, log);
    return { status: 'FAILED', reason };
  }

  const publishable = (connection.capabilities as { publishableContentTypes?: string[] })
    .publishableContentTypes;
  if (Array.isArray(publishable) && !publishable.includes(content.contentType)) {
    const unavailable = (connection.capabilities as { unavailable?: Record<string, string> })
      .unavailable;
    const reason =
      unavailable?.publish ??
      `The connected ${connection.provider} account cannot publish ${content.contentType}.`;
    await failPermanently(context, payload, content.id, 'UNSUPPORTED_CAPABILITY', reason, log);
    return { status: 'FAILED', reason };
  }

  // Autopilot gate. Applies only when no person triggered this job.
  if (!payload.actorUserId) {
    const gate = await checkAutopilot(context, payload.organizationId, content);
    if (!gate.eligible) {
      const reason = `Autopilot is not permitted to publish this content: ${gate.blockers.join(' ')}`;
      await failPermanently(context, payload, content.id, 'AUTOPILOT_BLOCKED', reason, log);
      await notify(context, {
        organizationId: payload.organizationId,
        type: 'APPROVAL_REQUIRED',
        severity: 'WARNING',
        title: 'Autopilot stopped a publication',
        body: reason,
        resourceType: 'ContentItem',
        resourceId: content.id,
      });
      return { status: 'BLOCKED', reason };
    }
  }

  const media = await loadMedia(context, content.mediaAssets, connection.provider);

  // Mark PUBLISHING and create the PENDING publication row *before* the provider
  // call, so a crash mid-flight leaves evidence that an attempt was in progress.
  await context.prisma.contentItem.update({
    where: { id: content.id },
    data: { status: 'PUBLISHING' },
  });

  const publication = await context.prisma.publication.upsert({
    where: { idempotencyKey },
    create: {
      organizationId: payload.organizationId,
      contentItemId: content.id,
      socialConnectionId: connection.id,
      provider: connection.provider,
      idempotencyKey,
      contentVersion: content.version,
      status: 'PENDING',
      attempts: 1,
      actorType: payload.actorUserId ? 'USER' : 'AGENT',
      actorUserId: payload.actorUserId ?? null,
    },
    update: { status: 'PENDING', attempts: { increment: 1 } },
    select: { id: true, attempts: true },
  });

  const post: PublishInput = {
    contentType: content.contentType,
    body: content.body,
    ...(content.threadParts.length > 0 ? { threadParts: content.threadParts } : {}),
    hashtags: content.hashtags,
    ...(media && media.length > 0 ? { media } : {}),
    idempotencyKey,
  };

  // A long provider call must not outlive the lock.
  await lock.extend(LOCK_TTL_MS).catch(() => undefined);

  try {
    const adapter = context.social.getConfigured(connection.provider);
    const result = await adapter.createPost({
      tokens: connection.tokens,
      account: {
        providerAccountId: connection.providerAccountId,
        accountName: connection.accountName,
        ...(connection.accountUsername ? { accountUsername: connection.accountUsername } : {}),
        metadata: connection.metadata,
      },
      post,
    });

    await context.prisma.$transaction([
      context.prisma.publication.update({
        where: { id: publication.id },
        data: {
          status: 'SUCCEEDED',
          providerPostId: result.providerPostId,
          providerPostIds: result.providerPostIds,
          providerUrl: result.url ?? null,
          publishedAt: result.publishedAt,
          providerResponse: result.metadata as object,
          errorCode: null,
          errorStatus: null,
          errorMessage: null,
        },
      }),
      context.prisma.contentItem.update({
        where: { id: content.id },
        data: { status: 'PUBLISHED', publishedAt: result.publishedAt },
      }),
    ]);

    log.info(
      {
        publicationId: publication.id,
        provider: connection.provider,
        providerPostId: result.providerPostId,
      },
      'Published successfully',
    );

    await audit(context, {
      action: 'content.published',
      organizationId: payload.organizationId,
      actorUserId: payload.actorUserId ?? null,
      actorType: payload.actorUserId ? 'USER' : 'AGENT',
      resourceType: 'ContentItem',
      resourceId: content.id,
      metadata: {
        provider: connection.provider,
        providerPostId: result.providerPostId,
        publicationId: publication.id,
        contentVersion: content.version,
      },
    });

    await notify(context, {
      organizationId: payload.organizationId,
      ...(payload.actorUserId ? { userId: payload.actorUserId } : {}),
      type: 'PUBLISHING_SUCCEEDED',
      title: `Published to ${connection.provider}`,
      body: result.url ?? null,
      resourceType: 'ContentItem',
      resourceId: content.id,
    });

    // First metric read after a short delay; the sweep job collects later ones.
    await context.queues[QUEUE_NAMES.analytics].add(
      JOB_NAMES.collectMetrics,
      {
        organizationId: payload.organizationId,
        publicationId: publication.id,
        correlationId: payload.correlationId,
      },
      {
        jobId: `metrics:${publication.id}:initial`,
        delay: 15 * 60 * 1000,
        attempts: 3,
      },
    );

    return { status: 'PUBLISHED', publicationId: publication.id };
  } catch (error) {
    return handlePublishFailure(context, {
      error,
      payload,
      contentId: content.id,
      publicationId: publication.id,
      provider: connection.provider,
      log,
    });
  }
}

/**
 * Classifies a provider failure and records it.
 *
 * The distinction that matters is whether the request could have reached the
 * provider. A rejected request (4xx) definitely did not create a post and is
 * safe to surface as a plain failure. A timeout or 5xx might have, so it is
 * quarantined instead of retried.
 */
async function handlePublishFailure(
  context: WorkerContext,
  input: {
    error: unknown;
    payload: PublishContentJob;
    contentId: string;
    publicationId: string;
    provider: string;
    log: JobLogger;
  },
): Promise<{ status: string; publicationId: string; reason: string }> {
  const { error, payload, contentId, publicationId, provider, log } = input;

  const providerStatus =
    error instanceof ProviderError ? error.providerStatus : undefined;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = sanitizeProviderMessage(rawMessage);

  // Partial thread publication: some posts are genuinely live. Recording the ids
  // matters more than the failure itself.
  const partialIds =
    error instanceof ProviderError &&
    Array.isArray((error.internalDetails as { publishedPostIds?: string[] })?.publishedPostIds)
      ? ((error.internalDetails as { publishedPostIds: string[] }).publishedPostIds)
      : [];

  const ambiguous = isAmbiguousDelivery(error) || partialIds.length > 0;

  await context.prisma.$transaction([
    context.prisma.publication.update({
      where: { id: publicationId },
      data: {
        status: 'FAILED',
        errorCode: ambiguous ? AMBIGUOUS : (providerStatus ? `HTTP_${providerStatus}` : 'PROVIDER_ERROR'),
        errorStatus: providerStatus ?? null,
        errorMessage: message.slice(0, 1_000),
        ...(partialIds.length > 0
          ? { providerPostIds: partialIds, providerPostId: partialIds[0] ?? null }
          : {}),
      },
    }),
    context.prisma.contentItem.update({
      where: { id: contentId },
      data: { status: 'FAILED' },
    }),
  ]);

  await audit(context, {
    action: 'content.publish_failed',
    organizationId: payload.organizationId,
    actorUserId: payload.actorUserId ?? null,
    actorType: payload.actorUserId ? 'USER' : 'AGENT',
    resourceType: 'ContentItem',
    resourceId: contentId,
    metadata: { provider, publicationId, providerStatus, ambiguous, message },
  });

  await notify(context, {
    organizationId: payload.organizationId,
    ...(payload.actorUserId ? { userId: payload.actorUserId } : {}),
    type: 'PUBLISHING_FAILED',
    severity: 'ERROR',
    title: ambiguous
      ? `${provider} publication needs verification`
      : `Publishing to ${provider} failed`,
    body: ambiguous
      ? 'The request may or may not have reached the provider. Check the account before retrying, ' +
        `so the post is not published twice. Provider reported: ${message}`
      : message,
    resourceType: 'ContentItem',
    resourceId: contentId,
  });

  log.error({ publicationId, provider, providerStatus, ambiguous, err: message }, 'Publish failed');

  if (ambiguous) {
    // Deliberately does NOT throw: throwing would let BullMQ retry, and a retry
    // here is exactly the double-publish risk this branch exists to prevent.
    return {
      status: 'NEEDS_VERIFICATION',
      publicationId,
      reason: 'Delivery could not be confirmed; quarantined for human verification.',
    };
  }

  // A definite rejection. Rate limits are worth another attempt; a 4xx
  // authentication or permission error never is.
  if (error instanceof RateLimitError) throw error;

  return { status: 'FAILED', publicationId, reason: message };
}

/**
 * True when we cannot tell whether the provider received the request.
 * Network errors, timeouts, aborts, and 5xx responses are all ambiguous.
 */
function isAmbiguousDelivery(error: unknown): boolean {
  if (error instanceof RateLimitError) return false;

  if (error instanceof ProviderError) {
    const status = error.providerStatus;
    // No status at all means the request never produced a response: a socket
    // failure or timeout, which may still have been processed upstream.
    if (status === undefined) return true;
    return status >= 500 || status === 408;
  }

  // An unrecognised error escaping the adapter is treated as ambiguous, because
  // assuming it is safe to retry is the dangerous assumption.
  return !(error instanceof Error && error.name === 'ValidationError');
}

/** Records a definite pre-send failure without ever contacting the provider. */
async function failPermanently(
  context: WorkerContext,
  payload: PublishContentJob,
  contentId: string,
  errorCode: string,
  reason: string,
  log: JobLogger,
): Promise<void> {
  log.warn({ contentItemId: contentId, errorCode }, reason);

  await context.prisma.contentItem.update({
    where: { id: contentId },
    data: { status: 'FAILED' },
  });

  await audit(context, {
    action: 'content.publish_failed',
    organizationId: payload.organizationId,
    actorUserId: payload.actorUserId ?? null,
    resourceType: 'ContentItem',
    resourceId: contentId,
    metadata: { errorCode, reason, reachedProvider: false },
  });
}

/** Server-side autopilot evaluation. Never trusts anything the model asserted. */
async function checkAutopilot(
  context: WorkerContext,
  organizationId: string,
  content: {
    contentType: string;
    riskLevel: string;
    flaggedTopics: string[];
    factualClaims: unknown;
  },
): Promise<{ eligible: boolean; blockers: string[] }> {
  const organization = await context.prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { automationMode: true, autopilotContentTypes: true },
  });

  const publishedInLast24h = await context.prisma.publication.count({
    where: {
      organizationId,
      status: 'SUCCEEDED',
      actorType: 'AGENT',
      publishedAt: { gte: new Date(Date.now() - 86_400_000) },
    },
  });

  // A claim counts as verified only if the stored verification says so.
  const claims = Array.isArray(content.factualClaims)
    ? (content.factualClaims as Array<{ verified?: boolean }>)
    : [];
  const hasUnverifiedClaims = claims.some((claim) => claim.verified !== true);

  return evaluateAutopilotEligibility({
    automationMode: organization.automationMode,
    riskLevel: content.riskLevel as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    flaggedTopics: content.flaggedTopics as ApprovalTopic[],
    allowedContentTypes: organization.autopilotContentTypes,
    contentType: content.contentType,
    hasUnverifiedClaims,
    connectionStatus: 'ACTIVE',
    publishedInLast24h,
    dailyLimit: context.config.worker.autopilotDailyPublishLimit,
  });
}

/**
 * Loads media in the shape the provider needs.
 *
 * Instagram fetches from a public URL and accepts no binary upload; X and
 * LinkedIn need the bytes. Anything missing is surfaced as an error rather than
 * quietly dropped, because publishing approved content without its media would
 * post something other than what was approved.
 */
async function loadMedia(
  context: WorkerContext,
  assets: Array<{
    brandAsset: {
      id: string;
      storageKey: string;
      mimeType: string;
      publicUrl: string | null;
      name: string;
    };
  }>,
  provider: string,
): Promise<PublishInput['media']> {
  if (assets.length === 0) return [];

  const media: NonNullable<PublishInput['media']> = [];

  for (const { brandAsset } of assets) {
    if (provider === 'INSTAGRAM') {
      const publicUrl = brandAsset.publicUrl ?? context.storage.publicUrl(brandAsset.storageKey);
      if (!publicUrl) {
        throw new ProviderError(
          'Instagram',
          `Media asset "${brandAsset.name}" has no public URL. Instagram builds a media container ` +
            'by fetching a public URL and accepts no direct upload. Set STORAGE_PUBLIC_BASE_URL.',
          { retryable: false },
        );
      }
      media.push({ publicUrl, mimeType: brandAsset.mimeType });
      continue;
    }

    const buffer = await context.storage.get(brandAsset.storageKey);
    media.push({ buffer, mimeType: brandAsset.mimeType });
  }

  return media;
}
