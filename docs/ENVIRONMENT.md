# Environment

Every variable the implementation reads. There are no unused placeholders.

Configuration is validated by Zod at startup. A misconfigured deployment **exits
immediately with a list of every problem**, rather than starting and failing on
the first request:

```
Invalid environment configuration:
  - WEB_URL: must be an absolute http(s) URL
  - ENCRYPTION_KEY: must decode to exactly 32 bytes (hex or base64)
  - OPENAI_DEFAULT_MODEL: Invalid input: expected string, received undefined
```

## All-or-nothing provider blocks

Optional integrations are validated as a unit. Supply **every** variable in a
block or **none**. Partial configuration is a startup error, never a silently
half-enabled integration:

```
Invalid environment configuration:
  - X (Twitter) integration is partially configured. Missing: X_REDIRECT_URI.
    Provide all of [X_CLIENT_ID, X_CLIENT_SECRET, X_REDIRECT_URI] or none of them.
```

---

## Application

| Variable | Required | Default | Notes |
|---|---|---|---|
| `APP_ENV` | no | `development` | `development` · `test` · `staging` · `production` |
| `NODE_ENV` | no | `development` | |
| `PORT` | no | `4000` | API listen port |
| `WEB_URL` | **yes** | — | Browser origin. **Must be https when `APP_ENV=production`** |
| `API_URL` | **yes** | — | Public API origin. Must be https in production |
| `CORS_ADDITIONAL_ORIGINS` | no | — | Comma separated. `WEB_URL` is always allowed |
| `LOG_LEVEL` | no | `info` | `fatal`…`trace` |

`WEB_URL` does double duty: it is the CORS allowlist origin and the base for
post-OAuth redirects.

---

## Data stores

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | PostgreSQL. Used by the runtime driver adapter and by `migrate deploy` |
| `REDIS_URL` | **yes** | BullMQ. Eviction policy must be `noeviction` |

---

## Authentication

| Variable | Required | Notes |
|---|---|---|
| `PRIVY_APP_ID` | **yes** | Public identifier. Also given to the browser as `NEXT_PUBLIC_PRIVY_APP_ID` |
| `PRIVY_APP_SECRET` | **yes** | **Server only.** Must never reach the browser |
| `PRIVY_VERIFICATION_KEY` | no | Public key. Set it to verify tokens offline with no per-request network call |

---

## Encryption

| Variable | Required | Notes |
|---|---|---|
| `ENCRYPTION_KEY` | **yes** | 32 bytes, hex or base64. Validated at startup |

```bash
openssl rand -hex 32
```

> **Losing this key permanently destroys every stored OAuth token.** There is no
> recovery path — that is what authenticated encryption means. Every social
> account would need reconnecting. Back it up in a secret manager, **separately
> from database backups**, so one compromise does not yield both.

Rotating it requires decrypting with the old key and re-encrypting with the new
one; the sealed format carries a `v1` prefix so a future rotation can be
distinguished.

---

## AI

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | **yes** | — | |
| `OPENAI_BASE_URL` | no | — | Only for an OpenAI-compatible gateway |
| `OPENAI_DEFAULT_MODEL` | **yes** | — | Content generation and strategy |
| `OPENAI_FAST_MODEL` | **yes** | — | Classification, extraction, short rewrites |
| `OPENAI_REASONING_MODEL` | **yes** | — | Scoring rationales, multi-step planning |
| `OPENAI_EMBEDDING_MODEL` | **yes** | — | Brand knowledge base |
| `OPENAI_EMBEDDING_DIMENSIONS` | no | `1536` | Must match the embedding model |
| `OPENAI_IMAGE_MODEL` | no | — | **Unset disables media generation entirely** |
| `AI_WEB_SEARCH_ENABLED` | no | `true` | Enables the WEB research source |
| `AI_REQUEST_TIMEOUT_MS` | no | `120000` | |
| `AI_MAX_RETRIES` | no | `2` | Transient failures only |

Model names are configuration, never hardcoded. Set them to models the account
actually has access to — the application does not assume availability.

**Changing `OPENAI_EMBEDDING_MODEL` or `OPENAI_EMBEDDING_DIMENSIONS` invalidates
every stored embedding.** Vectors from different models are not comparable, and
mismatched dimensions score 0 by design. Re-index the knowledge base after
changing either.

Leaving `OPENAI_IMAGE_MODEL` unset is a supported configuration: media
generation is disabled and reported as unavailable rather than offering a
button that cannot work.

---

## Knowledge base

| Variable | Required | Default | Notes |
|---|---|---|---|
| `KNOWLEDGE_VECTOR_BACKEND` | no | `inprocess` | Retrieval ranks in PostgreSQL via `kult_cosine_similarity` |
| `KNOWLEDGE_INPROCESS_MAX_CHUNKS` | no | `5000` | Guard rail on corpus size per organization |

No vector extension or external vector database is required.

---

## Object storage (optional block)

All five or none. Without it, document upload and media assets are refused with
a message naming these variables.

| Variable | Notes |
|---|---|
| `STORAGE_ENDPOINT` | S3-compatible endpoint |
| `STORAGE_REGION` | |
| `STORAGE_BUCKET` | |
| `STORAGE_ACCESS_KEY` | |
| `STORAGE_SECRET_KEY` | |
| `STORAGE_PUBLIC_BASE_URL` | Separate. **Required for Instagram publishing** |
| `STORAGE_FORCE_PATH_STYLE` | `true` for MinIO and some R2 setups |

`STORAGE_PUBLIC_BASE_URL` is not part of the all-or-nothing block because
storage is useful without it. But Instagram builds a media container by fetching
a public URL and accepts no binary upload, so **Instagram publishing is
impossible without it** — and the Integrations screen says so.

Works with AWS S3, Cloudflare R2, MinIO, or any S3-compatible provider. No
provider-specific assumption exists outside the storage adapter.

---

## Social integrations (optional blocks)

Each block is all-or-nothing. See
[SOCIAL-INTEGRATIONS.md](SOCIAL-INTEGRATIONS.md) for setup and real limits.

### X

| Variable | Notes |
|---|---|
| `X_CLIENT_ID` | Confidential client |
| `X_CLIENT_SECRET` | |
| `X_REDIRECT_URI` | Must match the portal **exactly** |

### Instagram (Meta)

| Variable | Notes |
|---|---|
| `META_APP_ID` | |
| `META_APP_SECRET` | |
| `META_REDIRECT_URI` | Must match exactly |
| `META_GRAPH_VERSION` | Default `v23.0` |

### LinkedIn

| Variable | Notes |
|---|---|
| `LINKEDIN_CLIENT_ID` | |
| `LINKEDIN_CLIENT_SECRET` | |
| `LINKEDIN_REDIRECT_URI` | Must match exactly |
| `LINKEDIN_API_VERSION` | Default `202608`. **Sunsets annually — keep current** |

---

## Research sources (all optional, independent)

| Variable | Enables | Notes |
|---|---|---|
| `X_BEARER_TOKEN` | X recent search | Requires a **paid** X API tier |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` + `REDDIT_USER_AGENT` | Reddit | All three or none. Reddit requires a descriptive User-Agent |
| `YOUTUBE_API_KEY` | YouTube | Data API v3 |

A source with no credentials appears in the UI as unavailable with the reason
and the variables that would enable it — never silently skipped.

There is no variable for Google Trends: Google publishes no official public API,
so it is permanently unavailable.

---

## Rate limiting, observability, worker

| Variable | Default | Notes |
|---|---|---|
| `RATE_LIMIT_TTL_SECONDS` | `60` | Application limiter window |
| `RATE_LIMIT_LIMIT` | `300` | Requests per window per IP |
| `SENTRY_DSN` | — | Optional error tracking |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | |
| `WORKER_CONCURRENCY` | `5` | Publishing is capped at 3 regardless |
| `AUTOPILOT_DAILY_PUBLISH_LIMIT` | `6` | Hard ceiling on autonomous posts per organization per day |

---

## Web (build time only)

**Next.js inlines `NEXT_PUBLIC_*` into the client bundle at build time.** Setting
them at runtime has no effect — changing either requires rebuilding the image.

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_API_URL` | Public API origin |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Public Privy identifier |

Neither is a secret. **No server-side secret may be passed as a build argument** —
they are recoverable from image layers.

---

## Local development

`.env` at the repository root is loaded automatically by the API and worker,
checking the app directory first and then the monorepo root. In containers no
`.env` exists, so this is a no-op and real environment variables always win.

Copy `.env.example` and fill in the four values needed to boot:
`ENCRYPTION_KEY`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `OPENAI_API_KEY`.
