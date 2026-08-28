# Deployment

Building, shipping and rolling back Kult Marketing OS.

---

## Images

Four images, all built from the repository root:

| Image | Dockerfile | Purpose |
|---|---|---|
| `kult-marketing-api` | `infra/docker/Dockerfile.api` | REST API |
| `kult-marketing-worker` | `infra/docker/Dockerfile.worker` | Queue consumers |
| `kult-marketing-web` | `infra/docker/Dockerfile.web` | Next.js frontend |
| `kult-marketing-migrate` | `infra/docker/Dockerfile.migrate` | One-shot migration job |

All use multi-stage builds and run as the unprivileged `node` user.

### The web image needs build arguments

Next.js **inlines `NEXT_PUBLIC_*` values into the client bundle at build time**.
Setting them in the container environment has no effect on an already-built
image — changing either one requires a rebuild.

```bash
docker build -f infra/docker/Dockerfile.web \
  --build-arg NEXT_PUBLIC_API_URL=https://api.kult.games \
  --build-arg NEXT_PUBLIC_PRIVY_APP_ID=your-privy-app-id \
  -t kult-marketing-web:$TAG .
```

The build fails immediately if either is missing, rather than shipping a bundle
pointing at `localhost`. Neither is a secret: the Privy app ID is a publishable
identifier and the API URL is a public endpoint. **No server-side secret is ever
passed as a build argument** — they would be recoverable from image layers.

The other three take no build arguments and read everything at runtime.

```bash
export TAG=$(git rev-parse --short HEAD)
docker build -f infra/docker/Dockerfile.api     -t kult-marketing-api:$TAG .
docker build -f infra/docker/Dockerfile.worker  -t kult-marketing-worker:$TAG .
docker build -f infra/docker/Dockerfile.migrate -t kult-marketing-migrate:$TAG .
```

---

## Single-host deployment

```bash
cp .env.example .env      # fill in every required value
docker compose -f docker-compose.production.yml up -d --build
```

The compose file starts nginx, web, api, worker, postgres and redis, plus the
migration job. `migrate` runs to completion first; api and worker wait on
`service_completed_successfully`, so the application never starts against an
un-migrated schema.

Only nginx binds to the host (80/443). **Postgres and Redis publish no ports.**

Required variables use `${VAR:?message}`, so a missing one fails at
`docker compose up` with a clear message rather than at runtime.

### Managed Postgres and Redis

Nothing assumes the databases are sibling containers. Point `DATABASE_URL` and
`REDIS_URL` at the managed services and start without the bundled ones:

```bash
docker compose -f docker-compose.production.yml \
  up -d --scale postgres=0 --scale redis=0
```

For managed Redis, confirm the eviction policy is **`noeviction`**. An eviction
policy that drops keys under memory pressure would silently discard delayed
publishing jobs. The reconciliation sweep would eventually repair them, but
posts would be late.

---

## Migrations

`prisma migrate deploy` is the only migration command that belongs in
production. It applies committed migration files and never generates, resets or
prompts. `migrate dev` and `db push` are development-only and are not reachable
from the migration image.

**Migrations must not run concurrently from multiple replicas.** That is why
they live in a dedicated one-shot container rather than an application
entrypoint. On Kubernetes this is a `Job`; on ECS a one-off task; in compose it
is the `migrate` service.

The entrypoint waits for the database (up to `MIGRATE_WAIT_SECONDS`, default 90),
prints current status, then applies.

Run it standalone against any environment:

```bash
docker run --rm -e DATABASE_URL="postgresql://..." kult-marketing-migrate:$TAG
```

### Writing a migration

```bash
# 1. Edit packages/database/prisma/schema.prisma
# 2. Generate SQL against a scratch database
pnpm --filter @kult/database migrate:dev --name descriptive_name
# 3. Review the generated SQL by hand. Always.
# 4. Commit both the schema and the migration directory.
```

Never edit an applied migration. Write a new one.

---

## Rollout order

Because the API and worker share a schema, order matters:

1. **Build and push** all four images with the same tag.
2. **Run the migration job.** It must succeed before anything else moves.
3. **Roll the worker.** It has a 90-second grace period so an in-flight
   publishing job settles rather than being killed mid-provider-call — which is
   exactly what creates an unverifiable publication.
4. **Roll the API.** Stateless, so a rolling restart is safe.
5. **Roll the web.**

### Backwards-compatible migrations

For a change that is not backwards compatible, use the expand/contract pattern
so old and new code can run side by side during the roll:

1. **Expand** — add the new nullable column or table. Deploy.
2. **Backfill** — populate it. Deploy code writing both old and new.
3. **Contract** — once no running code reads the old shape, drop it.

Compressing this into one step means the old replicas break the moment the
migration lands.

---

## Rollback

**Application rollback** is straightforward: redeploy the previous image tag.
The API and worker hold no state that a rollback would corrupt, and publishing
idempotency keys are derived from content, not from a deployment.

**Schema rollback is not automatic.** Prisma has no `migrate down`. If a
migration must be reversed:

1. Stop the worker first, so no job writes through the old schema.
2. Apply a hand-written reversal migration, or restore from backup (see
   [RUNBOOK.md](RUNBOOK.md)).
3. Redeploy the matching application tag.

This is why every migration should be reviewed by hand before it is committed.

If a rollback crosses a migration boundary, prefer **rolling forward** with a
corrective migration. It is almost always safer than reversing.

---

## nginx and TLS

`infra/nginx/conf.d/kult.conf` serves the web app and the API on separate
hostnames, so browser CORS is a real boundary rather than a formality.

Replace `app.kult.games` and `api.kult.games` with the real hostnames and mount
certificates at `${TLS_CERT_DIR}`:

```
/etc/nginx/certs/app.kult.games/fullchain.pem
/etc/nginx/certs/app.kult.games/privkey.pem
/etc/nginx/certs/api.kult.games/fullchain.pem
/etc/nginx/certs/api.kult.games/privkey.pem
```

Port 80 exists only for the ACME challenge and the redirect to HTTPS.

**Enable HSTS only once HTTPS works on every subdomain** covered by
`includeSubDomains`. It is difficult to walk back.

Configured limits: 12 MB request body (the API caps uploads at 5 MB), 180-second
read timeout on the API for copilot turns, buffering disabled so streamed
responses reach the client as produced, and edge rate limits in front of the
application's own limiter.

---

## Configuration to change per environment

Beyond secrets, these must match the deployment:

| Setting | Where | Note |
|---|---|---|
| `WEB_URL`, `API_URL` | env | Must be https in production; validated at startup |
| `NEXT_PUBLIC_API_URL` | **build arg** | Rebuild required to change |
| `NEXT_PUBLIC_PRIVY_APP_ID` | **build arg** | Rebuild required to change |
| OAuth redirect URIs | env + provider portal | Must match **exactly**, including scheme and path |
| Privy allowed domains | Privy dashboard | Add the web origin |
| `server_name`, cert paths | `infra/nginx/conf.d/` | |
| `LINKEDIN_API_VERSION` | env | LinkedIn sunsets versions annually — see below |

### OAuth redirect URIs

Register these exactly as configured:

```
https://api.kult.games/api/v1/integrations/x/callback
https://api.kult.games/api/v1/integrations/instagram/callback
https://api.kult.games/api/v1/integrations/linkedin/callback
```

They point at the **API**, not the web app: the callback needs server-side state
lookup and token exchange. The API then redirects the browser back to the web
app.

### LinkedIn version pinning

LinkedIn sunsets a versioned API roughly a year after release — version `202508`
was sunset on 2026-08-17. `LINKEDIN_API_VERSION` defaults to `202608`. Check the
LinkedIn migrations page before each deployment; an expired version fails every
LinkedIn call.

---

## Scaling

**API** — stateless. Scale with `API_REPLICAS`. Size the Postgres pool
accordingly: each replica opens up to 10 connections.

**Worker** — horizontally scalable; coordination is entirely through Redis.
Scale with `WORKER_REPLICAS`. The publishing lock means two workers cannot post
the same content, and the idempotency key means they could not double-post even
if the lock were lost.

Publishing concurrency is deliberately capped at 3 per worker regardless of
`WORKER_CONCURRENCY`, because it hits external rate limits and is the only queue
whose jobs are irreversible.

**Web** — stateless, scale freely.

**Postgres** is the bottleneck that matters. Knowledge retrieval is a sequential
scan per organization; if a tenant's corpus grows past tens of thousands of
chunks, move to pgvector with an HNSW index.

---

## Verifying a deployment

```bash
curl -fsS https://api.kult.games/health
curl -fsS https://api.kult.games/ready      # 200 only when Postgres and Redis both answer

# Auth is enforced
curl -s -o /dev/null -w '%{http_code}\n' https://api.kult.games/api/v1/organization   # 401

# Worker is consuming
docker compose -f docker-compose.production.yml logs worker | grep "Worker listening"

# Schedulers registered
docker compose -f docker-compose.production.yml logs worker | grep "Scheduled:"
```

Then, in the application: sign in, confirm the dashboard loads, open Integrations
and confirm each provider reports the expected configured/unconfigured state.

See [PRODUCTION_READINESS.md](../PRODUCTION_READINESS.md) for the full checklist
and for what has and has not actually been verified.
