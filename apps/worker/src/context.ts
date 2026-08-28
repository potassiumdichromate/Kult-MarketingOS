import OpenAI from 'openai';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { getConfig, type AppConfig } from '@kult/config';
import { createPrismaClient, type PrismaClient } from '@kult/database';
import {
  ResearchSourceRegistry,
  SecretBox,
  SocialProviderRegistry,
  createStorage,
  type StorageAdapter,
} from '@kult/integrations';
import {
  AIService,
  AgentOrchestrator,
  AgentRunner,
  BrandContextLoader,
  KnowledgeBase,
  createWebResearchAdapter,
} from '@kult/ai';
import { QUEUE_NAMES, type QueueName } from '@kult/shared';
import { logger } from './logger.js';

/**
 * Worker composition root.
 *
 * Built once at boot and passed to every processor. Two connection pools are
 * created deliberately: BullMQ needs a dedicated blocking connection, so sharing
 * one Redis client between the queues and the workers would stall job pickup.
 */
export interface WorkerContext {
  config: AppConfig;
  prisma: PrismaClient;
  redis: Redis;
  /** Separate connection for BullMQ workers, which block on BRPOPLPUSH. */
  workerRedis: Redis;
  secrets: SecretBox;
  storage: StorageAdapter;
  social: SocialProviderRegistry;
  research: ResearchSourceRegistry;
  ai: AIService;
  openai: OpenAI;
  knowledge: KnowledgeBase;
  brand: BrandContextLoader;
  agents: AgentRunner;
  orchestrator: AgentOrchestrator;
  queues: Record<QueueName, Queue>;
}

function redisConnection(url: string, role: string): Redis {
  const client = new Redis(url, {
    // BullMQ requires this to be null: it manages its own retry semantics.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  client.on('error', (error: Error) => {
    // Never let a transient Redis error take the process down; ioredis reconnects.
    logger.error({ role, err: error.message }, 'Redis connection error');
  });
  return client;
}

export function createContext(): WorkerContext {
  const config = getConfig();

  const prisma = createPrismaClient({
    connectionString: config.databaseUrl,
    // The worker runs long jobs concurrently, so it needs headroom over the API.
    maxConnections: Math.max(10, config.worker.concurrency * 2),
    logQueries: false,
  });

  const redis = redisConnection(config.redisUrl, 'producer');
  const workerRedis = redisConnection(config.redisUrl, 'consumer');

  const secrets = new SecretBox(config.encryptionKey);
  const storage = createStorage(config.storage);
  const social = new SocialProviderRegistry(config, storage);
  const ai = new AIService(config.ai);
  const research = new ResearchSourceRegistry(config, createWebResearchAdapter({ ai }));

  const openai = new OpenAI({
    apiKey: config.ai.apiKey,
    ...(config.ai.baseURL ? { baseURL: config.ai.baseURL } : {}),
    timeout: config.ai.timeoutMs,
  });

  const knowledge = new KnowledgeBase(prisma, ai);
  const brand = new BrandContextLoader(prisma, knowledge);

  const queues = Object.fromEntries(
    Object.values(QUEUE_NAMES).map((name) => [
      name,
      new Queue(name, {
        connection: redis,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 24 * 3600, count: 1_000 },
          removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
        },
      }),
    ]),
  ) as Record<QueueName, Queue>;

  return {
    config,
    prisma,
    redis,
    workerRedis,
    secrets,
    storage,
    social,
    research,
    ai,
    openai,
    knowledge,
    brand,
    agents: new AgentRunner(prisma),
    orchestrator: new AgentOrchestrator(prisma),
    queues,
  };
}

export async function destroyContext(context: WorkerContext): Promise<void> {
  await Promise.allSettled([
    ...Object.values(context.queues).map((queue) => queue.close()),
    context.prisma.$disconnect(),
    context.redis.quit(),
    context.workerRedis.quit(),
  ]);
}

/** Builds the agent execution context used by every AI job. */
export function agentContext(
  context: WorkerContext,
  input: { organizationId: string; correlationId: string; triggeredByUserId?: string; workflowExecutionId?: string },
) {
  return {
    organizationId: input.organizationId,
    prisma: context.prisma,
    ai: context.ai,
    brand: context.brand,
    knowledge: context.knowledge,
    correlationId: input.correlationId,
    ...(input.triggeredByUserId ? { triggeredByUserId: input.triggeredByUserId } : {}),
    ...(input.workflowExecutionId ? { workflowExecutionId: input.workflowExecutionId } : {}),
  };
}
