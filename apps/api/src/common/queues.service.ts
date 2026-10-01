import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, type QueueName } from '@kult/shared';
import { RedisService } from './core.module.js';

/**
 * Queue producers.
 *
 * The API only ever enqueues; it never processes. A request that would trigger
 * research, generation, publishing, or metric collection creates the database
 * record, enqueues a job, and returns an id - keeping long-running work off the
 * request path entirely.
 */

export interface EnqueueOptions {
  /** Deterministic id. Re-enqueuing the same id is a no-op in BullMQ. */
  jobId?: string;
  /** Delay in milliseconds. Used for scheduled publishing. */
  delayMs?: number;
  attempts?: number;
  priority?: number;
}

@Injectable()
export class QueuesService implements OnModuleDestroy {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly logger = new Logger('Queues');

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    for (const name of Object.values(QUEUE_NAMES)) {
      this.queues.set(
        name,
        new Queue(name, {
          connection: this.redis.client,
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            // Keep a bounded history so failures stay inspectable without
            // growing Redis without limit.
            removeOnComplete: { age: 24 * 3600, count: 1_000 },
            removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
          },
        }),
      );
    }
  }

  queue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Unknown queue: ${name}`);
    return queue;
  }

  async enqueue<T extends object>(
    queueName: QueueName,
    jobName: string,
    data: T,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const job = await this.queue(queueName).add(jobName, data, {
      ...(options.jobId ? { jobId: options.jobId } : {}),
      ...(options.delayMs !== undefined ? { delay: Math.max(0, options.delayMs) } : {}),
      ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
    });

    // The jobId and correlationId link this line to the worker's "Job started"
    // and "Job finished" lines. Only ids are logged, never the payload.
    const ids = data as { organizationId?: unknown; correlationId?: unknown };
    this.logger.log({
      message: 'Job enqueued',
      queue: queueName,
      jobName,
      jobId: job.id,
      ...(options.delayMs !== undefined
        ? { runsAt: new Date(Date.now() + Math.max(0, options.delayMs)).toISOString() }
        : {}),
      ...(typeof ids.organizationId === 'string' ? { organizationId: ids.organizationId } : {}),
      ...(typeof ids.correlationId === 'string' ? { correlationId: ids.correlationId } : {}),
    });

    return job.id ?? '';
  }

  /**
   * Removes a job by its deterministic id.
   * Used when content is rescheduled or cancelled before it publishes.
   */
  async remove(queueName: QueueName, jobId: string): Promise<boolean> {
    const job = await this.queue(queueName).getJob(jobId);
    if (!job) return false;
    // A job already being processed must not be yanked out from under the worker;
    // the worker's own idempotency check is what protects correctness there.
    const state = await job.getState();
    if (state === 'active') {
      this.logger.warn({
        message: 'Job not removed: a worker is already processing it',
        queue: queueName,
        jobId,
      });
      return false;
    }
    await job.remove();
    this.logger.log({ message: 'Job removed', queue: queueName, jobId, previousState: state });
    return true;
  }

  async exists(queueName: QueueName, jobId: string): Promise<boolean> {
    return Boolean(await this.queue(queueName).getJob(jobId));
  }

  async counts(queueName: QueueName): Promise<Record<string, number>> {
    return this.queue(queueName).getJobCounts();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close().catch(() => undefined)));
  }
}
