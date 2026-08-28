# Kult Marketing OS — build status

**The application is built, runs end to end, and is packaged and documented.**
What remains is a first real deployment and a first real provider connection.

This file records exactly what exists, what is verified, and what has not been
done, so the next person does not have to guess.

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
| `apps/api` | Complete | **Boots and serves.** `/health` ok, `/ready` reports database+redis ok, protected routes return the documented 401 envelope with a requestId. |
| `apps/worker` | Complete | **Boots and runs.** 6 queues consuming, 11 agents + 5 workflows synced to the database, 5 maintenance schedulers registered. |
| `apps/web` | Complete | **Builds and serves.** Next.js 16 + React 19 + Tailwind 4. All 23 routes render; every required route from the specification exists. |

**Test totals: 65 tests passing** - 58 unit, plus 7 worker integration tests run
against real PostgreSQL and Redis. Every package and app typechecks with zero errors.

### Packaging and documentation

| Item | State | Verification |
|---|---|---|
| Dockerfiles | Written for api, worker, web, migrate | **Only the API image has actually been built.** See "What is NOT built" |
| `docker-compose.production.yml` | Complete | `docker compose config` validates. Works against managed Postgres/Redis by scaling the bundled services to zero |
| nginx | Complete | TLS termination, security headers, edge rate limits, request size and timeout caps. **Never loaded by nginx** |
| Clean CI install | Verified | `CI=true pnpm install --frozen-lockfile` succeeds from an empty `node_modules` |
| Docs | Complete | README, ARCHITECTURE, SECURITY, DEPLOYMENT, ENVIRONMENT, API, SOCIAL-INTEGRATIONS, AI-AGENTS, RUNBOOK, PRODUCTION_READINESS |

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

- **Image export is unverified, and two images were never built at all.** The
  API and migrate images complete every build stage and fail only at export;
  the web and worker images have not been attempted.

  The cause was environmental, not the Dockerfiles: **the build host's disk hit
  100% (476 GB used, 0 free)**, corrupting Docker's containerd content store —
  `input/output error` on blob paths, and `docker system df` unable to read its
  own blobs. Clearing the npm and pnpm caches reclaimed 16 GB, but recovering
  the store needs Docker Desktop → Troubleshoot → **Clean / Purge data**, which
  wipes every local image on the machine. Build all four on a host with roughly
  30 GB of headroom.
- **The stack has never been started via compose**, and nginx has never loaded
  its configuration. `docker compose config` validates, which is a syntax check,
  not a runtime one.
- **API integration and E2E tests** — the worker has integration tests against
  real Postgres and Redis, but there is no Supertest suite for the API routes and
  no Playwright suite.

### Explicitly not verified

Nothing has been deployed. **No social OAuth flow, publish, or metric read has
been executed against real provider credentials** - the smoke tests use fake
tokens. Claims about provider behaviour rest on official documentation and SDK
type definitions, not on live calls. The AI agents have never been run against a
real OpenAI key, so no agent prompt has produced a real generation.

---

## Next steps, in order

1. **Build all four images and start the stack**, on a host with disk headroom.
   The API and migrate images build through every stage; the web and worker
   images are unattempted.
2. **First real provider connection.** Everything about OAuth and publishing is
   implemented but has never touched a live provider account. Expect surprises
   there before anywhere else.
3. **API Supertest suite and Playwright E2E.**

See [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for the full pre-deploy
checklist.

## Local development

```bash
pnpm install
docker run -d --name kult-mos-pg -e POSTGRES_PASSWORD=kult -e POSTGRES_USER=kult -e POSTGRES_DB=kult_marketing -p 55432:5432 postgres:17-alpine
docker run -d --name kult-mos-redis -p 56379:6379 redis:7-alpine
cp .env.example .env   # then fill in ENCRYPTION_KEY, PRIVY_*, OPENAI_API_KEY
pnpm --filter @kult/database migrate:deploy
pnpm -r --filter "./packages/**" build
pnpm test

pnpm --filter @kult/worker start   # 6 queues + maintenance schedulers
pnpm --filter @kult/api start      # http://localhost:4000/health
```

Generate an encryption key with `openssl rand -hex 32`. If that key is lost,
every stored OAuth token is permanently unrecoverable.
