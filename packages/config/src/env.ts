import { z } from 'zod';

/**
 * Environment schema for Kult Marketing OS.
 *
 * Rules:
 *  - Only variables that are actually consumed by the implementation appear here.
 *  - Secrets are never given defaults.
 *  - Optional provider blocks are validated as a unit: a provider is "configured"
 *    only when every variable it needs is present. Partial configuration is a
 *    startup error, never a silent half-enabled integration.
 */

const nonEmpty = z.string().trim().min(1);

const httpUrl = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL');

/** 32-byte key, hex (64 chars) or base64. Used for AES-256-GCM token encryption. */
const encryptionKey = z
  .string()
  .trim()
  .refine((value) => decodeKeyLength(value) === 32, 'must decode to exactly 32 bytes (hex or base64)');

function decodeKeyLength(value: string): number {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return 32;
  try {
    return Buffer.from(value, 'base64').length;
  } catch {
    return -1;
  }
}

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()),
  );

const csv = z
  .string()
  .trim()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

export const envSchema = z.object({
  // ---- Application ----------------------------------------------------------
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_URL: httpUrl,
  API_URL: httpUrl,
  /** Extra browser origins allowed by CORS, in addition to WEB_URL. */
  CORS_ADDITIONAL_ORIGINS: csv.optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ---- Data stores ----------------------------------------------------------
  DATABASE_URL: nonEmpty,
  REDIS_URL: nonEmpty,

  // ---- Authentication (Privy) ----------------------------------------------
  PRIVY_APP_ID: nonEmpty,
  PRIVY_APP_SECRET: nonEmpty,
  /**
   * Privy verification (public) key for offline JWT verification.
   * Optional: when absent the SDK fetches and caches the JWKS itself.
   */
  PRIVY_VERIFICATION_KEY: z.string().trim().optional(),

  // ---- Secret handling ------------------------------------------------------
  ENCRYPTION_KEY: encryptionKey,

  // ---- AI -------------------------------------------------------------------
  OPENAI_API_KEY: nonEmpty,
  OPENAI_BASE_URL: httpUrl.optional(),
  OPENAI_DEFAULT_MODEL: nonEmpty,
  OPENAI_FAST_MODEL: nonEmpty,
  OPENAI_REASONING_MODEL: nonEmpty,
  OPENAI_EMBEDDING_MODEL: nonEmpty,
  OPENAI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  /** Set only if the account has image generation enabled; unset disables media generation. */
  OPENAI_IMAGE_MODEL: z.string().trim().optional(),
  /** Enables the hosted web_search tool for research agents. */
  AI_WEB_SEARCH_ENABLED: booleanish.default(true),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  // ---- Knowledge base vector backend ---------------------------------------
  /**
   * pgvector  -> requires the `vector` extension in DATABASE_URL's database.
   * inprocess -> cosine similarity computed in Node over org-scoped chunks.
   */
  KNOWLEDGE_VECTOR_BACKEND: z.enum(['pgvector', 'inprocess']).default('inprocess'),
  KNOWLEDGE_INPROCESS_MAX_CHUNKS: z.coerce.number().int().positive().default(5_000),

  // ---- Object storage (S3-compatible) --------------------------------------
  STORAGE_ENDPOINT: httpUrl.optional(),
  STORAGE_REGION: z.string().trim().optional(),
  STORAGE_BUCKET: z.string().trim().optional(),
  STORAGE_ACCESS_KEY: z.string().trim().optional(),
  STORAGE_SECRET_KEY: z.string().trim().optional(),
  /** Set when the bucket is served from a CDN / public base different to the endpoint. */
  STORAGE_PUBLIC_BASE_URL: httpUrl.optional(),
  /** Path-style addressing is required by MinIO and some R2 configurations. */
  STORAGE_FORCE_PATH_STYLE: booleanish.default(false),

  // ---- Social: X ------------------------------------------------------------
  X_CLIENT_ID: z.string().trim().optional(),
  X_CLIENT_SECRET: z.string().trim().optional(),
  X_REDIRECT_URI: httpUrl.optional(),
  /** App-only bearer token, used exclusively for X as a *research* source. */
  X_BEARER_TOKEN: z.string().trim().optional(),

  // ---- Social: Instagram (via Meta) ----------------------------------------
  META_APP_ID: z.string().trim().optional(),
  META_APP_SECRET: z.string().trim().optional(),
  META_REDIRECT_URI: httpUrl.optional(),
  META_GRAPH_VERSION: z.string().trim().regex(/^v\d+\.\d+$/, 'must look like v23.0').default('v23.0'),

  // ---- Social: LinkedIn -----------------------------------------------------
  LINKEDIN_CLIENT_ID: z.string().trim().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().trim().optional(),
  LINKEDIN_REDIRECT_URI: httpUrl.optional(),
  /**
   * LinkedIn versioned-API moniker (YYYYMM). LinkedIn sunsets versions roughly a
   * year after release - 202508 was sunset on 2026-08-17 - so this must be kept
   * current. Verify against the LinkedIn migrations page before changing.
   */
  LINKEDIN_API_VERSION: z.string().trim().regex(/^\d{6}$/, 'must be YYYYMM').default('202608'),

  // ---- Research sources -----------------------------------------------------
  REDDIT_CLIENT_ID: z.string().trim().optional(),
  REDDIT_CLIENT_SECRET: z.string().trim().optional(),
  REDDIT_USER_AGENT: z.string().trim().optional(),
  YOUTUBE_API_KEY: z.string().trim().optional(),

  // ---- Rate limiting --------------------------------------------------------
  RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_LIMIT: z.coerce.number().int().positive().default(300),

  // ---- Observability --------------------------------------------------------
  SENTRY_DSN: z.string().trim().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  // ---- Worker ---------------------------------------------------------------
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  /** Guard rail: hard cap on autopilot publications per organization per day. */
  AUTOPILOT_DAILY_PUBLISH_LIMIT: z.coerce.number().int().positive().default(6),
});

export type RawEnv = z.infer<typeof envSchema>;
