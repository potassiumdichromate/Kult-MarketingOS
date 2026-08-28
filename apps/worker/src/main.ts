// Loads .env for local development, checking the app directory first and then the
// monorepo root. In containers there is no .env file, so this is a no-op and real
// environment variables always take precedence.
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../.env')], quiet: true });
import { Worker, type Job, type Processor } from 'bullmq';
import { ConfigurationError } from '@kult/config';
import { syncAgentDefinitions } from '@kult/ai';
import { QUEUE_NAMES, type QueueName } from '@kult/shared';
import { createContext, destroyContext, type WorkerContext } from './context.js';
import { JOB_NAMES } from './jobs.js';
import { jobLogger, logger } from './logger.js';
import { processPublishContent } from './processors/publishing.js';
import { processRunResearch } from './processors/research.js';
import {
  processDiscoverNiches,
  processGenerateCampaign,
  processGenerateContent,
  processGenerateOpportunities,
} from './processors/ai.js';
import { processIndexDocument } from './processors/content.js';
import {
  processCollectMetrics,
  processPerformanceReview,
  processSweepMetrics,
} from './processors/analytics.js';
import {
  processExpireOpportunities,
  processPurgeOAuthStates,
  processReconcileSchedules,
  processRefreshTokens,
} from './processors/maintenance.js';

/**
 * Worker entrypoint.
 *
 * Runs as a separate process from the API so that research, generation, and
 * publishing never occupy an HTTP request. It is horizontally scalable: all
 * coordination happens through Redis and the database, and no job state lives in
 * memory between jobs.
 */

type JobHandler = (
  context: WorkerContext,
  job: Job,
  log: ReturnType<typeof jobLogger>,
) => Promise<unknown>;

/** Job name to handler, per queue. */
const HANDLERS: Record<QueueName, Record<string, JobHandler>> = {
  [QUEUE_NAMES.publishing]: {
    [JOB_NAMES.publishContent]: processPublishContent,
  },
  [QUEUE_NAMES.research]: {
    [JOB_NAMES.runResearch]: processRunResearch,
  },
  [QUEUE_NAMES.ai]: {
    [JOB_NAMES.generateOpportunities]: processGenerateOpportunities,
    [JOB_NAMES.discoverNiches]: processDiscoverNiches,
    [JOB_NAMES.generateCampaign]: processGenerateCampaign,
    [JOB_NAMES.generateContent]: processGenerateContent,
  },
  [QUEUE_NAMES.content]: {
    [JOB_NAMES.indexDocument]: processIndexDocument,
    // Maintenance sweeps ride the content queue: they are low-volume and must
    // not compete with publishing for concurrency slots.
    [JOB_NAMES.reconcileSchedules]: processReconcileSchedules,
    [JOB_NAMES.refreshTokens]: processRefreshTokens,
    [JOB_NAMES.expireOpportunities]: processExpireOpportunities,
    [JOB_NAMES.purgeOAuthStates]: processPurgeOAuthStates,
  },
  [QUEUE_NAMES.analytics]: {
    [JOB_NAMES.collectMetrics]: processCollectMetrics,
    [JOB_NAMES.sweepMetrics]: processSweepMetrics,
    [JOB_NAMES.performanceReview]: processPerformanceReview,
  },
  [QUEUE_NAMES.notifications]: {},
};

/**
 * Per-queue concurrency.
 *
 * Publishing is deliberately serialised more tightly than the rest: it hits
 * external rate limits and is the only queue whose jobs have irreversible
 * effects, so a smaller in-flight count is worth the throughput.
 */
function concurrencyFor(queue: QueueName, base: number): number {
  switch (queue) {
    case QUEUE_NAMES.publishing:
      return Math.max(1, Math.min(3, base));
    case QUEUE_NAMES.ai:
      return Math.max(1, Math.ceil(base / 2));
    default:
      return base;
  }
}

function buildProcessor(context: WorkerContext, queue: QueueName): Processor {
  const handlers = HANDLERS[queue];

  return async (job: Job) => {
    const log = jobLogger({
      queue,
      jobName: job.name,
      jobId: job.id ?? 'unknown',
      ...(typeof job.data?.organizationId === 'string'
        ? { organizationId: job.data.organizationId }
        : {}),
      ...(typeof job.data?.correlationId === 'string'
        ? { correlationId: job.data.correlationId }
        : {}),
    });

    const handler = handlers[job.name];
    if (!handler) {
      // An unknown job name is a deployment mismatch, not a transient fault.
      // Failing loudly beats retrying something nothing can handle.
      log.error('No handler registered for this job name');
      throw new Error(`No handler registered for job "${job.name}" on queue "${queue}".`);
    }

    const started = Date.now();
    log.info({ attempt: job.attemptsMade + 1 }, 'Job started');

    try {
      const result = await handler(context, job, log);
      log.info({ durationMs: Date.now() - started, result }, 'Job finished');
      return result;
    } catch (error) {
      log.error(
        {
          durationMs: Date.now() - started,
          attempt: job.attemptsMade + 1,
          err: error instanceof Error ? error.message : String(error),
        },
        'Job failed',
      );
      throw error;
    }
  };
}

/**
 * Registers repeatable maintenance jobs.
 *
 * Repeatable jobs are keyed by name, so re-registering on every boot converges
 * rather than accumulating duplicates across deployments.
 */
async function registerSchedules(context: WorkerContext): Promise<void> {
  const content = context.queues[QUEUE_NAMES.content];
  const analytics = context.queues[QUEUE_NAMES.analytics];

  const schedules: Array<{
    queue: typeof content;
    name: string;
    pattern: string;
    description: string;
  }> = [
    {
      queue: content,
      name: JOB_NAMES.reconcileSchedules,
      pattern: '*/5 * * * *',
      description: 'Repair scheduled content whose queue job is missing',
    },
    {
      queue: content,
      name: JOB_NAMES.refreshTokens,
      pattern: '0 * * * *',
      description: 'Renew social tokens approaching expiry',
    },
    {
      queue: content,
      name: JOB_NAMES.expireOpportunities,
      pattern: '0 * * * *',
      description: 'Expire stale opportunities and decay trends',
    },
    {
      queue: content,
      name: JOB_NAMES.purgeOAuthStates,
      pattern: '*/30 * * * *',
      description: 'Delete expired OAuth state rows',
    },
    {
      queue: analytics,
      name: JOB_NAMES.sweepMetrics,
      pattern: '0 */6 * * *',
      description: 'Re-read metrics for recently published posts',
    },
  ];

  for (const schedule of schedules) {
    // BullMQ 6 replaced repeatable job options with job schedulers. Upserting by
    // a stable scheduler id means re-registering on every boot converges instead
    // of accumulating duplicate schedules across deployments.
    await schedule.queue.upsertJobScheduler(
      schedule.name,
      { pattern: schedule.pattern },
      {
        name: schedule.name,
        data: {},
        opts: {
          // Maintenance jobs must not pile up if the worker was down.
          removeOnComplete: { count: 20 },
          removeOnFail: { count: 50 },
          attempts: 1,
        },
      },
    );
    logger.info(
      { job: schedule.name, pattern: schedule.pattern },
      `Scheduled: ${schedule.description}`,
    );
  }
}

async function bootstrap(): Promise<void> {
  let context: WorkerContext;

  try {
    context = createContext();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      logger.fatal(error.message);
      process.exit(1);
    }
    throw error;
  }

  // Mirror the code's agent and workflow definitions into the database so the
  // agents screen shows what this deployment can actually run.
  try {
    const synced = await syncAgentDefinitions(context.prisma);
    logger.info(synced, 'Synced agent and workflow definitions');
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Failed to sync agent definitions; continuing',
    );
  }

  const workers: Worker[] = [];

  for (const queue of Object.values(QUEUE_NAMES)) {
    const worker = new Worker(queue, buildProcessor(context, queue), {
      connection: context.workerRedis,
      concurrency: concurrencyFor(queue, context.config.worker.concurrency),
      // A publishing job that outlives this is assumed dead by BullMQ; keep it
      // above the provider timeouts so a slow provider is not treated as a stall.
      lockDuration: 10 * 60 * 1000,
    });

    worker.on('failed', (job, error) => {
      logger.error(
        { queue, jobId: job?.id, jobName: job?.name, err: error?.message },
        'Job failed permanently or will retry',
      );
    });
    worker.on('error', (error) => {
      logger.error({ queue, err: error.message }, 'Worker error');
    });

    workers.push(worker);
    logger.info(
      { queue, concurrency: concurrencyFor(queue, context.config.worker.concurrency) },
      'Worker listening',
    );
  }

  await registerSchedules(context);

  logger.info(
    { environment: context.config.appEnv, queues: Object.values(QUEUE_NAMES) },
    'Kult Marketing OS worker started',
  );

  // Graceful shutdown: stop accepting new jobs, let in-flight jobs finish, then
  // release connections. Killing a publishing job mid-flight is exactly the
  // situation that produces an unverifiable publication.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down; waiting for in-flight jobs');

    const timeout = setTimeout(() => {
      logger.error('Shutdown timed out after 60s; exiting');
      process.exit(1);
    }, 60_000);

    try {
      await Promise.all(workers.map((worker) => worker.close()));
      await destroyContext(context);
      clearTimeout(timeout);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Error during shutdown',
      );
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'Unhandled promise rejection');
  });
}

void bootstrap();
