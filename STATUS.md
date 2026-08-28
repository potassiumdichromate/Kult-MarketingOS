# Kult Marketing OS — build status

**This project is incomplete.** The session ended partway through the build. This
file records exactly what exists, what is verified, and what has not been built,
so the next person does not have to guess.

Last updated: 2026-08-28

---

## What is done and verified

Everything below typechecks (`tsc --noEmit`, zero errors) and, where noted, was
executed against real infrastructure.

### Foundation

| Package | State | Verification |
|---|---|---|
| `packages/config` | Complete | Typechecks. Zod 4 env schema, all-or-nothing provider blocks, fails fast at startup with a list of problems. |
| `packages/shared` | Complete | **31 unit tests pass.** Errors, RBAC matrix, platform constraints, deterministic scoring, idempotency keys, secret redaction, content state machine, autopilot eligibility. |
| `packages/database` | Complete | **Migrations applied to real PostgreSQL 17** (48 tables). Prisma 7 + `@prisma/adapter-pg`. Cosine-similarity SQL function verified on all edge cases (identical=1, orthogonal=0, dimension mismatch=0, zero vector=0). |
| `packages/auth` | Complete | Typechecks. Privy server-side token verification, app-id cross-check, RBAC assertion layer. |
| `packages/integrations` | Complete | **27 unit tests pass.** AES-256-GCM token sealing, PKCE, SSRF guard, X / Instagram / LinkedIn adapters, S3 storage, research source adapters. |
| `packages/ai` | Complete | Typechecks against the real OpenAI SDK v7. AIService, 11 agents, orchestrator, knowledge base, safety layer. |
| `apps/api` | Complete | Typechecks. NestJS 12, ~45 endpoints, global auth + permission guards, audit logging, Swagger. |

**Test totals: 58 unit tests, all passing.**

### External API contracts — verified against official documentation

Every one of these was checked against the provider's current official docs or
against the installed SDK's own type definitions, not from memory:

- **Prisma 7** — `url` is no longer permitted in the datasource block; connection
  string moves to `prisma.config.ts` and a driver adapter is required at runtime.
- **Prisma CLI** — npm `latest` is an 8.0 release candidate; pinned to stable 7.10.0.
- **OpenAI SDK v7** — `responses.parse`, `zodTextFormat` (confirmed Zod 4 support),
  `web_search` tool, streaming, embeddings.
- **Privy server-auth 1.32** — `verifyAuthToken`, `getUser({ idToken })`.
- **BullMQ 6** — `ioredis` is now an optional peer; connection/job API confirmed.
- **X API** — `POST /2/tweets`, OAuth2 PKCE endpoints, scopes, chunked media upload.
- **Instagram** — Business Login endpoints, token exchange/refresh, container +
  publish endpoints, **carousel limit of 10**, **100 posts / 24h**.
- **LinkedIn** — `POST /rest/posts`, required headers, post URN returned in the
  `x-restli-id` header, permission model.
- **LinkedIn version `202508` was sunset on 2026-08-17** — the default was
  corrected to `202608`.

### Provider limitations handled honestly (not faked)

- **LinkedIn refresh tokens** are partner-gated. `refreshToken()` raises
  `UnsupportedCapabilityError` and the connection is marked `EXPIRED` for
  re-authorization, rather than pretending to refresh.
- **LinkedIn post metrics** require `r_member_social` (approval-only). The adapter
  reports the exact requirement instead of returning zeros.
- **LinkedIn media** requires the Images/Videos API for an asset URN. Not
  implemented, so attaching media raises `UNSUPPORTED_CAPABILITY` rather than
  silently dropping the media from approved content.
- **Instagram** requires a professional account and a *publicly reachable media
  URL*. Both are detected and reported with the precise fix.
- **Google Trends** has no official public API. The source is permanently
  reported as unavailable with an explanation rather than scraped.
- **Reddit / Discord publishing** are marked not publishable with a reason.

---

## What is NOT built

These are absent, not stubbed. There are no placeholder files pretending
otherwise.

- **`apps/worker`** — package manifest and tsconfig only. **No source.** This is
  the single most important gap: the API enqueues publishing, research,
  generation, and analytics jobs that currently have no consumer. Nothing
  publishes, and no scheduled content will ever fire.
- **`apps/web`** — package manifest only. **No source.** No login page, no
  dashboard, no studio, no calendar. All 17 planned routes are unbuilt.
- **`packages/ui`** — manifest only. Design tokens were extracted from the
  sibling Kult app (dark, purple/cyan neon, Sora + JetBrains Mono, radius
  0.75rem) but not written down here.
- **Docker / nginx / compose** — nothing in `infra/`.
- **Documentation** — only `.env.example` (which is complete and accurate) and
  this file. `README`, `ARCHITECTURE`, `SECURITY`, `DEPLOYMENT`, `API`,
  `SOCIAL-INTEGRATIONS`, `AI-AGENTS`, `RUNBOOK`, `PRODUCTION_READINESS` are all
  unwritten.
- **Integration and E2E tests** — only unit tests exist. No Supertest suite, no
  Playwright suite.
- **API boot smoke test** — the API typechecks but was **never started**. It has
  not been run against Postgres/Redis even once.

### Explicitly not verified

Nothing in this repository has been deployed, and no social OAuth flow has been
run against real credentials. Claims about provider behaviour rest on official
documentation and SDK type definitions, not on live calls.

---

## Next steps, in order

1. **Boot the API.** Typechecking is not running. Expect DI wiring problems on
   first start.
2. **Build `apps/worker`.** Publishing queue first: idempotency key → distributed
   lock → check existing `Publication` → publish → record provider response.
   The DB schema and the shared helpers (`publishingIdempotencyKey`,
   `publishingLockKey`, `publishJobId`) are already in place for this.
   Include the reconciliation pass that repairs scheduled content whose queue job
   is missing.
3. **Build `apps/web`.**
4. **Docker, nginx, docs, E2E.**

## Local development

```bash
pnpm install
docker run -d --name kult-mos-pg -e POSTGRES_PASSWORD=kult -e POSTGRES_USER=kult -e POSTGRES_DB=kult_marketing -p 55432:5432 postgres:17-alpine
docker run -d --name kult-mos-redis -p 56379:6379 redis:7-alpine
cp .env.example .env   # then fill in ENCRYPTION_KEY, PRIVY_*, OPENAI_API_KEY
pnpm --filter @kult/database migrate:deploy
pnpm -r --filter "./packages/**" build
pnpm test
```

Generate an encryption key with `openssl rand -hex 32`. If that key is lost,
every stored OAuth token is permanently unrecoverable.
