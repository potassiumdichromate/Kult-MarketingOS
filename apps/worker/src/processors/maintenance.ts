import type { Job } from 'bullmq';
import { QUEUE_NAMES, getCapability, publishJobId } from '@kult/shared';
import { UnsupportedCapabilityError } from '@kult/shared';
import type { WorkerContext } from '../context.js';
import { JOB_NAMES } from '../jobs.js';
import { notify } from '../lib/notify.js';
import type { JobLogger } from '../logger.js';

/**
 * Maintenance sweeps.
 *
 * These exist because the database is the source of truth and Redis is not.
 * A queue is a coordination mechanism that can lose state - a flush, a failover,
 * a misconfigured eviction policy - and scheduled content must survive that.
 */

// ---------------------------------------------------------------------------
// Schedule reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconciles scheduled content against the publishing queue.
 *
 * Three divergences are repaired:
 *
 *  1. **Scheduled in the database, no queue job.** The job was lost. Re-enqueue
 *     it, or publish immediately if its time has already passed.
 *  2. **Overdue and still SCHEDULED.** Its moment passed without the worker
 *     picking it up. Handled by the same re-enqueue, with a zero delay.
 *  3. **Stuck in PUBLISHING.** A worker crashed mid-publish. This is *not*
 *     auto-retried: the post may already be live. It is surfaced for human
 *     verification, because a duplicate post is worse than a delayed one.
 *
 * A queue job with no database record needs no repair: the processor already
 * treats missing content as a permanent skip.
 */
export async function processReconcileSchedules(
  context: WorkerContext,
  _job: Job,
  log: JobLogger,
): Promise<{ requeued: number; stuck: number }> {
  const scheduled = await context.prisma.contentItem.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledAt: { not: null },
    },
    select: {
      id: true,
      organizationId: true,
      version: true,
      contentType: true,
      scheduledAt: true,
      title: true,
    },
    take: 1_000,
  });

  const publishing = context.queues[QUEUE_NAMES.publishing];
  let requeued = 0;

  for (const item of scheduled) {
    if (!item.scheduledAt) continue;

    const jobId = publishJobId(item.id, item.version);
    const existing = await publishing.getJob(jobId);

    if (existing) {
      const state = await existing.getState().catch(() => 'unknown');
      // A completed or failed job for content still marked SCHEDULED means the
      // publish outcome was never written back. Leave it: the publication row is
      // authoritative and the processor is idempotent on re-run.
      if (state !== 'completed' && state !== 'failed') continue;
    }

    const capability = getCapability(item.contentType);
    if (!capability.publishable || !capability.provider) continue;

    const connection = await context.prisma.socialConnection.findFirst({
      where: {
        organizationId: item.organizationId,
        provider: capability.provider,
        status: 'ACTIVE',
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!connection) {
      // Nothing to publish through. Surface it rather than silently dropping
      // content the user believes is scheduled.
      await notify(context, {
        organizationId: item.organizationId,
        type: 'PUBLISHING_FAILED',
        severity: 'WARNING',
        title: 'Scheduled content has no connected account',
        body:
          `"${item.title ?? item.id}" is scheduled for ${capability.provider}, but no active ` +
          `${capability.provider} connection exists. Reconnect the account under Integrations.`,
        resourceType: 'ContentItem',
        resourceId: item.id,
      });
      continue;
    }

    const delayMs = Math.max(0, item.scheduledAt.getTime() - Date.now());

    await publishing.add(
      JOB_NAMES.publishContent,
      {
        contentItemId: item.id,
        organizationId: item.organizationId,
        socialConnectionId: connection.id,
        contentVersion: item.version,
        correlationId: `reconcile:${Date.now()}`,
      },
      { jobId, delay: delayMs, attempts: 5 },
    );

    requeued += 1;
    log.warn(
      { contentItemId: item.id, delayMs, overdue: delayMs === 0 },
      'Re-enqueued scheduled content whose publishing job was missing',
    );
  }

  // Content stuck in PUBLISHING for more than 30 minutes: a worker died mid-flight.
  const stuckThreshold = new Date(Date.now() - 30 * 60 * 1000);
  const stuck = await context.prisma.contentItem.findMany({
    where: { status: 'PUBLISHING', updatedAt: { lt: stuckThreshold } },
    select: { id: true, organizationId: true, title: true },
    take: 100,
  });

  for (const item of stuck) {
    // Deliberately not re-queued: whether the provider received the post is
    // unknown, and re-publishing is the one failure mode we must never cause.
    await context.prisma.contentItem.update({
      where: { id: item.id },
      data: { status: 'FAILED' },
    });

    await notify(context, {
      organizationId: item.organizationId,
      type: 'PUBLISHING_FAILED',
      severity: 'ERROR',
      title: 'Publication interrupted and needs verification',
      body:
        `"${item.title ?? item.id}" was interrupted while publishing. Check the connected account ` +
        'to see whether the post went out before retrying, so it is not published twice.',
      resourceType: 'ContentItem',
      resourceId: item.id,
    });

    log.error({ contentItemId: item.id }, 'Content stuck in PUBLISHING; flagged for verification');
  }

  return { requeued, stuck: stuck.length };
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Proactively renews connections approaching expiry.
 *
 * Running ahead of expiry matters because publishing is often scheduled: a token
 * that lapses overnight would otherwise fail a morning post. Providers that
 * cannot refresh programmatically - LinkedIn, in general - are marked EXPIRED
 * and the organization is told to reconnect, rather than being left to discover
 * it when a publish fails.
 */
export async function processRefreshTokens(
  context: WorkerContext,
  _job: Job,
  log: JobLogger,
): Promise<{ refreshed: number; failed: number }> {
  const horizon = new Date(Date.now() + 24 * 3_600_000);

  const connections = await context.prisma.socialConnection.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { not: null, lt: horizon },
    },
    select: {
      id: true,
      organizationId: true,
      provider: true,
      accountName: true,
      accessTokenEncrypted: true,
      refreshTokenEncrypted: true,
    },
    take: 200,
  });

  let refreshed = 0;
  let failed = 0;

  for (const connection of connections) {
    try {
      const adapter = context.social.getConfigured(connection.provider);
      const credential =
        connection.provider === 'INSTAGRAM'
          ? context.secrets.decrypt(connection.accessTokenEncrypted)
          : connection.refreshTokenEncrypted
            ? context.secrets.decrypt(connection.refreshTokenEncrypted)
            : '';

      const tokens = await adapter.refreshToken(credential);

      await context.prisma.socialConnection.update({
        where: { id: connection.id },
        data: {
          accessTokenEncrypted: context.secrets.encrypt(tokens.accessToken),
          ...(tokens.refreshToken
            ? { refreshTokenEncrypted: context.secrets.encrypt(tokens.refreshToken) }
            : {}),
          expiresAt: tokens.expiresAt ?? null,
          status: 'ACTIVE',
          lastValidatedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      refreshed += 1;
    } catch (error) {
      failed += 1;
      const reason =
        error instanceof UnsupportedCapabilityError
          ? error.requirement
          : error instanceof Error
            ? error.message
            : 'Token refresh failed.';

      await context.prisma.socialConnection.update({
        where: { id: connection.id },
        data: {
          status: 'EXPIRED',
          lastErrorCode: 'REFRESH_FAILED',
          lastErrorMessage: reason.slice(0, 1_000),
        },
      });

      await notify(context, {
        organizationId: connection.organizationId,
        type: 'TOKEN_EXPIRED',
        severity: 'WARNING',
        title: `Reconnect ${connection.provider}`,
        body: `The connection for ${connection.accountName} needs to be renewed. ${reason}`,
        resourceType: 'SocialConnection',
        resourceId: connection.id,
      });

      log.warn(
        { connectionId: connection.id, provider: connection.provider, reason },
        'Token refresh failed; connection marked EXPIRED',
      );
    }
  }

  return { refreshed, failed };
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Expires opportunities past their window and decays stale trends. */
export async function processExpireOpportunities(
  context: WorkerContext,
  _job: Job,
  log: JobLogger,
): Promise<{ opportunities: number; trends: number }> {
  const now = new Date();

  const opportunities = await context.prisma.opportunity.updateMany({
    where: {
      expiresAt: { not: null, lt: now },
      status: { in: ['NEW', 'REVIEWED', 'SELECTED'] },
    },
    data: { status: 'EXPIRED' },
  });

  // A trend unseen for a week is declining; unseen for a month, expired.
  const decliningThreshold = new Date(now.getTime() - 7 * 86_400_000);
  const expiredThreshold = new Date(now.getTime() - 30 * 86_400_000);

  const [declining, expired] = await Promise.all([
    context.prisma.trend.updateMany({
      where: {
        lastSeenAt: { lt: decliningThreshold, gte: expiredThreshold },
        status: { in: ['EMERGING', 'ACTIVE'] },
      },
      data: { status: 'DECLINING' },
    }),
    context.prisma.trend.updateMany({
      where: { lastSeenAt: { lt: expiredThreshold }, status: { not: 'EXPIRED' } },
      data: { status: 'EXPIRED' },
    }),
  ]);

  log.info(
    { opportunities: opportunities.count, declining: declining.count, expired: expired.count },
    'Expired stale opportunities and trends',
  );

  return { opportunities: opportunities.count, trends: declining.count + expired.count };
}

/** Deletes expired OAuth state rows. They are single-use and short-lived. */
export async function processPurgeOAuthStates(
  context: WorkerContext,
  _job: Job,
  log: JobLogger,
): Promise<{ purged: number }> {
  const result = await context.prisma.oAuthState.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (result.count > 0) log.info({ purged: result.count }, 'Purged expired OAuth states');
  return { purged: result.count };
}
