# Kult Marketing OS

AI-powered marketing intelligence and automation for [Kult](https://app.kult.games).

An internal tool for the Kult marketing team. It researches what is happening in
the spaces Kult competes in, scores what matters, turns that into
platform-native content, routes it through human approval, publishes it, and
learns from how it performed.

---

## What it does

**Discover.** Collects from RSS, Reddit, YouTube, X and the web, deduplicates by
canonical URL, then clusters the results into named trends. Every trend score is
arithmetic over measured signals — velocity, growth, engagement, recency, brand
relevance, audience overlap, minus saturation, competition and risk. The model
explains the score; it never invents it. Each trend links to the actual sources
behind it.

**Decide.** Turns trends and niches into scored opportunities that answer one
question: what should Kult talk about right now, and in what form.

**Create.** Writes platform-native copy grounded in the brand knowledge base.
Every factual claim is extracted and matched against approved claims; anything
unmatched is flagged and blocked from autonomous publishing.

**Ship.** Approval workflow, scheduling in the organization's own timezone, and
publishing through X, Instagram and LinkedIn with a hard guarantee that the same
content version is never published twice.

**Learn.** Collects metrics where providers expose them, analyses what worked,
and proposes strategy insights for a human to accept or reject.

---

## Principles this codebase holds to

These are not aspirations. They are visible in the code and enforced by tests.

**The AI never invents facts about Kult.** Generated factual claims are matched
against `ApprovedClaim` rows in code, not by asking the model whether it was
truthful. With no approved claims recorded, the system is instructed to assert
nothing specific — producing cautious content rather than confident fiction.

**Scores are computed, not generated.** Deterministic arithmetic in
`packages/shared/src/scoring.ts` produces every score. The model supplies
qualitative judgements as inputs and writes the explanation afterwards.

**A metric that was not measured is never zero.** LinkedIn does not expose
per-post engagement without approval-gated access, so LinkedIn posts have no
metric snapshots — and the UI says exactly that instead of rendering `0`.

**Provider limits are surfaced, not worked around.** Instagram needs a
professional account and a publicly reachable media URL. LinkedIn refresh tokens
are partner-gated. Google Trends has no official API. Each is detected, reported
with the precise fix, and never faked.

**Publishing is at-most-once.** An idempotency key with a unique constraint, a
Redis lock, and an ambiguity quarantine for timeouts where delivery cannot be
confirmed. A stalled publication a human resolves beats a duplicate post.

**Autopilot is off by default and hard to turn on.** Even enabled, it publishes
only LOW-risk content with no flagged topics, every claim verified, an
allowlisted content type, and within a daily cap.

---

## Architecture

```
                    ┌──────────┐
   browser ────────▶│  nginx   │  TLS, rate limits, security headers
                    └────┬─────┘
                ┌────────┴────────┐
                ▼                 ▼
         ┌───────────┐      ┌───────────┐
         │    web    │      │    api    │  NestJS · auth · RBAC · audit
         │ Next.js16 │      └─────┬─────┘
         └───────────┘            │ enqueues, never processes
                                  ▼
                            ┌───────────┐
                            │   redis   │  BullMQ · 6 queues
                            └─────┬─────┘
                                  ▼
                            ┌───────────┐
                            │  worker   │  research · AI · publishing · metrics
                            └─────┬─────┘
                                  ▼
                            ┌───────────┐
                            │ postgres  │  source of truth
                            └───────────┘
```

The API is stateless and scales horizontally. The worker is horizontally
scalable, coordinating only through Redis. No business state lives in memory.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full picture.

### Layout

```
apps/
  web/          Next.js 16 · React 19 · Tailwind 4
  api/          NestJS 12 · ~45 REST endpoints · OpenAPI
  worker/       BullMQ 6 · 6 queues · 5 maintenance schedulers
packages/
  config/       Zod 4 environment validation
  shared/       errors · RBAC · platform limits · scoring · idempotency
  database/     Prisma 7 schema · migrations · tenant scoping
  auth/         Privy server-side verification
  integrations/ crypto · SSRF guard · storage · social · research adapters
  ai/           AIService · 11 agents · orchestrator · knowledge base · safety
infra/
  docker/       Dockerfiles for web, api, worker, migrate
  nginx/        TLS termination and routing
docs/
```

---

## Getting started

Requires Node 22+, pnpm 11+, and Docker.

```bash
pnpm install

# Local Postgres and Redis
docker run -d --name kult-mos-pg -e POSTGRES_PASSWORD=kult -e POSTGRES_USER=kult \
  -e POSTGRES_DB=kult_marketing -p 55432:5432 postgres:17-alpine
docker run -d --name kult-mos-redis -p 56379:6379 redis:7-alpine

cp .env.example .env
```

Fill in at minimum `ENCRYPTION_KEY`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET` and
`OPENAI_API_KEY`. Generate the encryption key with:

```bash
openssl rand -hex 32
```

> **If that key is lost, every stored OAuth token becomes permanently
> unrecoverable** and every social account must be reconnected. Back it up in a
> secret manager, separately from database backups.

Then:

```bash
pnpm --filter @kult/database migrate:deploy
pnpm -r --filter "./packages/**" build

pnpm --filter @kult/worker start   # queues and schedulers
pnpm --filter @kult/api start      # http://localhost:4000/health
pnpm --filter @kult/web dev        # http://localhost:3000
```

The API's OpenAPI schema is at `/api/v1/openapi.json` and its explorer at
`/api/v1/docs`.

---

## Testing

```bash
pnpm test
```

65 tests. The worker's integration suite runs against real Postgres and Redis
and is skipped automatically when `DATABASE_URL` and `REDIS_URL` are unset.

---

## Documentation

| Document | Covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit and why |
| [SECURITY.md](docs/SECURITY.md) | Threat model and every control |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, nginx, rollout, rollback |
| [ENVIRONMENT.md](docs/ENVIRONMENT.md) | Every variable, what it does |
| [API.md](docs/API.md) | Endpoints, auth, error envelope |
| [SOCIAL-INTEGRATIONS.md](docs/SOCIAL-INTEGRATIONS.md) | Provider setup and real limits |
| [AI-AGENTS.md](docs/AI-AGENTS.md) | The 11 agents and their contracts |
| [RUNBOOK.md](docs/RUNBOOK.md) | Backups, incidents, common failures |
| [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) | What is verified, what is not |

**Read [`STATUS.md`](STATUS.md) first.** It records exactly what has been built
and verified versus what has not, without optimism.
