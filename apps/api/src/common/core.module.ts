import { Global, Module, type OnModuleDestroy } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import Redis from 'ioredis';
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
  BrandContextLoader,
  KnowledgeBase,
  createWebResearchAdapter,
} from '@kult/ai';
import {
  AI_SERVICE,
  APP_CONFIG,
  BRAND_LOADER,
  KNOWLEDGE_BASE,
  OPENAI_CLIENT,
  PRISMA,
  RESEARCH_REGISTRY,
  SECRET_BOX,
  SOCIAL_REGISTRY,
  STORAGE,
} from './tokens.js';

/**
 * Composition root.
 *
 * Every cross-cutting dependency is constructed once here from validated
 * configuration and injected everywhere else. No module reads process.env, and
 * no service constructs its own OpenAI or Prisma client - which is what keeps
 * model selection, connection pooling, and secret handling in one place.
 */

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.redisUrl, {
      // BullMQ requires this to be null on shared connections.
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    // A connection error must not take the process down; readiness reports it.
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

@Injectable()
export class PrismaLifecycle implements OnModuleDestroy {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => getConfig() },
    {
      provide: PRISMA,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): PrismaClient =>
        createPrismaClient({
          connectionString: config.databaseUrl,
          maxConnections: 10,
          logQueries: false,
        }),
    },
    {
      provide: SECRET_BOX,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SecretBox => new SecretBox(config.encryptionKey),
    },
    {
      provide: STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): StorageAdapter => createStorage(config.storage),
    },
    {
      provide: SOCIAL_REGISTRY,
      inject: [APP_CONFIG, STORAGE],
      useFactory: (config: AppConfig, storage: StorageAdapter): SocialProviderRegistry =>
        new SocialProviderRegistry(config, storage),
    },
    {
      provide: AI_SERVICE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): AIService => new AIService(config.ai),
    },
    {
      provide: OPENAI_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): OpenAI =>
        new OpenAI({
          apiKey: config.ai.apiKey,
          ...(config.ai.baseURL ? { baseURL: config.ai.baseURL } : {}),
          timeout: config.ai.timeoutMs,
        }),
    },
    {
      provide: KNOWLEDGE_BASE,
      inject: [PRISMA, AI_SERVICE],
      useFactory: (prisma: PrismaClient, ai: AIService): KnowledgeBase =>
        new KnowledgeBase(prisma, ai),
    },
    {
      provide: BRAND_LOADER,
      inject: [PRISMA, KNOWLEDGE_BASE],
      useFactory: (prisma: PrismaClient, knowledge: KnowledgeBase): BrandContextLoader =>
        new BrandContextLoader(prisma, knowledge),
    },
    {
      provide: RESEARCH_REGISTRY,
      inject: [APP_CONFIG, AI_SERVICE],
      useFactory: (config: AppConfig, ai: AIService): ResearchSourceRegistry =>
        new ResearchSourceRegistry(config, createWebResearchAdapter({ ai })),
    },
    RedisService,
    PrismaLifecycle,
  ],
  exports: [
    APP_CONFIG,
    PRISMA,
    SECRET_BOX,
    STORAGE,
    SOCIAL_REGISTRY,
    AI_SERVICE,
    OPENAI_CLIENT,
    KNOWLEDGE_BASE,
    BRAND_LOADER,
    RESEARCH_REGISTRY,
    RedisService,
  ],
})
export class CoreModule {}
