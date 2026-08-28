import { envSchema, type RawEnv } from './env.js';

export class ConfigurationError extends Error {
  public readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
  forcePathStyle: boolean;
}

export interface XConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface MetaConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphVersion: string;
}

export interface LinkedInConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiVersion: string;
}

export interface RedditConfig {
  clientId: string;
  clientSecret: string;
  userAgent: string;
}

export interface AIProviderConfig {
  apiKey: string;
  baseURL?: string;
  models: {
    /** Balanced default for content generation and strategy. */
    default: string;
    /** Low-latency model for classification, extraction, short rewrites. */
    fast: string;
    /** Higher-effort model for scoring rationales and multi-step planning. */
    reasoning: string;
    /** Embedding model backing the brand knowledge base. */
    embedding: string;
    /** Image model. Undefined disables media generation end to end. */
    image?: string;
  };
  embeddingDimensions: number;
  webSearchEnabled: boolean;
  timeoutMs: number;
  maxRetries: number;
}

export interface AppConfig {
  appEnv: RawEnv['APP_ENV'];
  nodeEnv: RawEnv['NODE_ENV'];
  isProduction: boolean;
  port: number;
  webUrl: string;
  apiUrl: string;
  corsOrigins: string[];
  logLevel: RawEnv['LOG_LEVEL'];

  databaseUrl: string;
  redisUrl: string;

  privy: { appId: string; appSecret: string; verificationKey?: string };
  encryptionKey: string;

  ai: AIProviderConfig;

  knowledge: {
    vectorBackend: RawEnv['KNOWLEDGE_VECTOR_BACKEND'];
    inprocessMaxChunks: number;
  };

  /** Undefined when object storage is not configured; uploads are then rejected explicitly. */
  storage?: StorageConfig;

  social: {
    x?: XConfig;
    meta?: MetaConfig;
    linkedin?: LinkedInConfig;
  };

  research: {
    xBearerToken?: string;
    reddit?: RedditConfig;
    youtubeApiKey?: string;
  };

  rateLimit: { ttlSeconds: number; limit: number };
  observability: { sentryDsn?: string; sentryTracesSampleRate: number };
  worker: { concurrency: number; autopilotDailyPublishLimit: number };
}

/**
 * Validates that an optional provider block is either fully present or fully absent.
 * Returns the assembled block, or undefined when the provider is not configured.
 */
function providerBlock<T extends Record<string, string | undefined>>(
  name: string,
  required: T,
  issues: string[],
): { [K in keyof T]: string } | undefined {
  const entries = Object.entries(required);
  const present = entries.filter(([, value]) => value !== undefined && value !== '');
  if (present.length === 0) return undefined;
  if (present.length !== entries.length) {
    const missing = entries.filter(([, value]) => !value).map(([key]) => key);
    issues.push(
      `${name} is partially configured. Missing: ${missing.join(', ')}. ` +
        `Provide all of [${entries.map(([key]) => key).join(', ')}] or none of them.`,
    );
    return undefined;
  }
  return required as { [K in keyof T]: string };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigurationError(issues);
  }
  const env = parsed.data;
  const issues: string[] = [];

  const storageBlock = providerBlock(
    'Object storage',
    {
      STORAGE_ENDPOINT: env.STORAGE_ENDPOINT,
      STORAGE_REGION: env.STORAGE_REGION,
      STORAGE_BUCKET: env.STORAGE_BUCKET,
      STORAGE_ACCESS_KEY: env.STORAGE_ACCESS_KEY,
      STORAGE_SECRET_KEY: env.STORAGE_SECRET_KEY,
    },
    issues,
  );

  const xBlock = providerBlock(
    'X (Twitter) integration',
    {
      X_CLIENT_ID: env.X_CLIENT_ID,
      X_CLIENT_SECRET: env.X_CLIENT_SECRET,
      X_REDIRECT_URI: env.X_REDIRECT_URI,
    },
    issues,
  );

  const metaBlock = providerBlock(
    'Instagram (Meta) integration',
    {
      META_APP_ID: env.META_APP_ID,
      META_APP_SECRET: env.META_APP_SECRET,
      META_REDIRECT_URI: env.META_REDIRECT_URI,
    },
    issues,
  );

  const linkedinBlock = providerBlock(
    'LinkedIn integration',
    {
      LINKEDIN_CLIENT_ID: env.LINKEDIN_CLIENT_ID,
      LINKEDIN_CLIENT_SECRET: env.LINKEDIN_CLIENT_SECRET,
      LINKEDIN_REDIRECT_URI: env.LINKEDIN_REDIRECT_URI,
    },
    issues,
  );

  const redditBlock = providerBlock(
    'Reddit research source',
    {
      REDDIT_CLIENT_ID: env.REDDIT_CLIENT_ID,
      REDDIT_CLIENT_SECRET: env.REDDIT_CLIENT_SECRET,
      REDDIT_USER_AGENT: env.REDDIT_USER_AGENT,
    },
    issues,
  );

  if (env.APP_ENV === 'production' && env.WEB_URL.startsWith('http://')) {
    issues.push('WEB_URL must use https in production.');
  }
  if (env.APP_ENV === 'production' && env.API_URL.startsWith('http://')) {
    issues.push('API_URL must use https in production.');
  }

  if (issues.length > 0) throw new ConfigurationError(issues);

  const corsOrigins = Array.from(
    new Set([new URL(env.WEB_URL).origin, ...(env.CORS_ADDITIONAL_ORIGINS ?? [])]),
  );

  return {
    appEnv: env.APP_ENV,
    nodeEnv: env.NODE_ENV,
    isProduction: env.APP_ENV === 'production',
    port: env.PORT,
    webUrl: env.WEB_URL.replace(/\/$/, ''),
    apiUrl: env.API_URL.replace(/\/$/, ''),
    corsOrigins,
    logLevel: env.LOG_LEVEL,

    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,

    privy: {
      appId: env.PRIVY_APP_ID,
      appSecret: env.PRIVY_APP_SECRET,
      ...(env.PRIVY_VERIFICATION_KEY ? { verificationKey: env.PRIVY_VERIFICATION_KEY } : {}),
    },
    encryptionKey: env.ENCRYPTION_KEY,

    ai: {
      apiKey: env.OPENAI_API_KEY,
      ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
      models: {
        default: env.OPENAI_DEFAULT_MODEL,
        fast: env.OPENAI_FAST_MODEL,
        reasoning: env.OPENAI_REASONING_MODEL,
        embedding: env.OPENAI_EMBEDDING_MODEL,
        ...(env.OPENAI_IMAGE_MODEL ? { image: env.OPENAI_IMAGE_MODEL } : {}),
      },
      embeddingDimensions: env.OPENAI_EMBEDDING_DIMENSIONS,
      webSearchEnabled: env.AI_WEB_SEARCH_ENABLED,
      timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      maxRetries: env.AI_MAX_RETRIES,
    },

    knowledge: {
      vectorBackend: env.KNOWLEDGE_VECTOR_BACKEND,
      inprocessMaxChunks: env.KNOWLEDGE_INPROCESS_MAX_CHUNKS,
    },

    ...(storageBlock
      ? {
          storage: {
            endpoint: storageBlock.STORAGE_ENDPOINT,
            region: storageBlock.STORAGE_REGION,
            bucket: storageBlock.STORAGE_BUCKET,
            accessKeyId: storageBlock.STORAGE_ACCESS_KEY,
            secretAccessKey: storageBlock.STORAGE_SECRET_KEY,
            ...(env.STORAGE_PUBLIC_BASE_URL ? { publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL } : {}),
            forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
          },
        }
      : {}),

    social: {
      ...(xBlock
        ? {
            x: {
              clientId: xBlock.X_CLIENT_ID,
              clientSecret: xBlock.X_CLIENT_SECRET,
              redirectUri: xBlock.X_REDIRECT_URI,
            },
          }
        : {}),
      ...(metaBlock
        ? {
            meta: {
              appId: metaBlock.META_APP_ID,
              appSecret: metaBlock.META_APP_SECRET,
              redirectUri: metaBlock.META_REDIRECT_URI,
              graphVersion: env.META_GRAPH_VERSION,
            },
          }
        : {}),
      ...(linkedinBlock
        ? {
            linkedin: {
              clientId: linkedinBlock.LINKEDIN_CLIENT_ID,
              clientSecret: linkedinBlock.LINKEDIN_CLIENT_SECRET,
              redirectUri: linkedinBlock.LINKEDIN_REDIRECT_URI,
              apiVersion: env.LINKEDIN_API_VERSION,
            },
          }
        : {}),
    },

    research: {
      ...(env.X_BEARER_TOKEN ? { xBearerToken: env.X_BEARER_TOKEN } : {}),
      ...(redditBlock
        ? {
            reddit: {
              clientId: redditBlock.REDDIT_CLIENT_ID,
              clientSecret: redditBlock.REDDIT_CLIENT_SECRET,
              userAgent: redditBlock.REDDIT_USER_AGENT,
            },
          }
        : {}),
      ...(env.YOUTUBE_API_KEY ? { youtubeApiKey: env.YOUTUBE_API_KEY } : {}),
    },

    rateLimit: { ttlSeconds: env.RATE_LIMIT_TTL_SECONDS, limit: env.RATE_LIMIT_LIMIT },
    observability: {
      ...(env.SENTRY_DSN ? { sentryDsn: env.SENTRY_DSN } : {}),
      sentryTracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    },
    worker: {
      concurrency: env.WORKER_CONCURRENCY,
      autopilotDailyPublishLimit: env.AUTOPILOT_DAILY_PUBLISH_LIMIT,
    },
  };
}

let cached: AppConfig | undefined;

/** Process-wide singleton. Throws on first call if the environment is invalid. */
export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test-only escape hatch so suites can install a fixture config. */
export function __setConfigForTests(config: AppConfig | undefined): void {
  cached = config;
}
