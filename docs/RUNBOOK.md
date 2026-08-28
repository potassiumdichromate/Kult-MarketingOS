# Runbook

Operating Kult Marketing OS: backups, recovery, and the failures you will
actually see.

---

## Backups

### PostgreSQL

The database is the source of truth. Everything in Redis can be rebuilt from it.

```bash
# Nightly logical backup
docker compose -f docker-compose.production.yml exec -T postgres \
  pg_dump -U kult -d kult_marketing --format=custom --compress=9 \
  > kult-$(date +%F).dump
```

Keep 30 daily and 12 monthly. Store off-host. **Test a restore quarterly** — an
untested backup is a hypothesis.

For managed Postgres, use the provider's automated backups and confirm
point-in-time recovery is enabled.

Restore:

```bash
docker compose -f docker-compose.production.yml stop api worker

docker compose -f docker-compose.production.yml exec -T postgres \
  pg_restore -U kult -d kult_marketing --clean --if-exists < kult-2026-08-28.dump

docker run --rm -e DATABASE_URL="$DATABASE_URL" kult-marketing-migrate:$TAG
docker compose -f docker-compose.production.yml start api worker
```

Stop the worker **first**. A running worker writing through a schema being
restored underneath it produces inconsistency that is hard to unpick.

### The encryption key

**Back up `ENCRYPTION_KEY` separately from database backups**, in a secret
manager, so one compromise does not yield both the ciphertext and the key.

> If the key is lost, every stored OAuth token is permanently unrecoverable.
> There is no recovery path — that is what authenticated encryption means. A
> database restore will succeed and every social connection will fail to
> decrypt. Recovery is: delete the connections and have each member reconnect.

Verify a key restore before you need it:

```bash
# Should print the account name, not a DecryptionError
docker compose -f docker-compose.production.yml exec api node -e "
const { SecretBox } = require('@kult/integrations');
const box = new SecretBox(process.env.ENCRYPTION_KEY);
console.log('key loads:', box.encrypt('probe').startsWith('v1.'));
"
```

### Redis

**Redis needs no backup.** It holds queue state only, and the database is
authoritative. AOF persistence (`appendonly yes`) is enabled so a restart does
not lose delayed jobs, but if Redis is lost entirely:

1. Scheduled content stays `SCHEDULED` in Postgres.
2. The reconciliation sweep runs every five minutes and re-enqueues anything
   whose queue job is missing.
3. Overdue items publish immediately; future ones are re-scheduled correctly.

Nothing is lost. Posts may be late by up to five minutes.

**Confirm the eviction policy is `noeviction`.** A policy that drops keys under
memory pressure silently discards jobs.

### Object storage

Media assets and uploaded documents. Use the provider's versioning and
lifecycle rules. Losing storage does not affect published posts — those live on
the platforms — but breaks Instagram publishing for content whose media is gone.

---

## Common failures

### Publication stuck as NEEDS_VERIFICATION

**What it means.** A timeout or 5xx occurred *during* the provider call. The post
may or may not have been created. The system deliberately does not retry, because
retrying risks a duplicate.

**What to do.**

1. Open the social account and check whether the post exists.
2. **If it exists**, mark the publication succeeded and record the provider id:

```sql
UPDATE "Publication"
SET status = 'SUCCEEDED', "providerPostId" = '<id from the platform>',
    "publishedAt" = now(), "errorCode" = NULL, "errorMessage" = NULL
WHERE id = '<publication id>';

UPDATE "ContentItem" SET status = 'PUBLISHED', "publishedAt" = now()
WHERE id = '<content item id>';
```

3. **If it does not exist**, return the content to `APPROVED` and publish again.
   The idempotency key is unchanged, so first clear the quarantined row:

```sql
DELETE FROM "Publication" WHERE id = '<publication id>';
UPDATE "ContentItem" SET status = 'APPROVED' WHERE id = '<content item id>';
```

This is the one failure that genuinely needs a human. That is by design.

### Content stuck in PUBLISHING

A worker died mid-publish. The reconciliation sweep flags it after 30 minutes,
sets it to `FAILED` and notifies. **It is not auto-retried** — same reasoning as
above. Follow the same procedure.

### A social connection keeps expiring

Check the provider:

- **X** — the connection needs the `offline.access` scope for refresh. Without
  it, access tokens expire after two hours. Reconnect and approve all scopes.
- **LinkedIn** — refresh tokens are partner-gated. If LinkedIn issued none,
  reconnection every 60 days is the expected behaviour, not a bug.
- **Instagram** — refresh needs the token to be at least 24 hours old and the
  account to still grant `instagram_business_basic`.

The hourly `refresh-tokens` sweep marks unrefreshable connections `EXPIRED` and
notifies, so this should never be a surprise.

### Instagram publishing fails with UNSUPPORTED_CAPABILITY

Two causes, both reported with the fix:

- **Not a professional account.** Convert to Business or Creator in the Instagram
  app and reconnect.
- **`STORAGE_PUBLIC_BASE_URL` unset.** Instagram fetches media from a public URL
  and accepts no upload. Set it to a publicly readable bucket or CDN origin.

### Every LinkedIn call fails

Most likely the API version was sunset. LinkedIn retires a version roughly a year
after release. Check the LinkedIn migrations page, update
`LINKEDIN_API_VERSION`, redeploy.

### Research collects nothing

1. Open **Research** and check source status. Unavailable sources show the reason
   and the variables that would enable them.
2. `ERROR` status shows the failure from the last run.
3. Remember Google Trends is permanently unavailable — Google publishes no
   official API.
4. Confirm sources are `ACTIVE`, not `DISABLED` or `UNAVAILABLE`.

### AI generation fails

```bash
docker compose -f docker-compose.production.yml logs api | grep AI_PROVIDER_ERROR
```

- **429** — rate limited. Retries are automatic and bounded; sustained 429s mean
  the account quota needs raising.
- **model not found** — a configured model name is not available to the account.
  These are configuration, not code.
- **no parseable structured output** — usually a truncated generation. Retried
  automatically; persistent failure suggests the schema is too large for the
  model.

### Queue backing up

```bash
docker compose -f docker-compose.production.yml exec redis \
  redis-cli --scan --pattern "bull:*:wait" | head
```

Scale workers with `WORKER_REPLICAS`. Publishing stays capped at 3 concurrent
per worker regardless — it hits external rate limits and is irreversible.

### Readiness failing

```bash
curl -s https://api.kult.games/ready
# {"status":"not_ready","checks":{"database":"unavailable","redis":"ok"}}
```

Names the failing dependency without disclosing a host or connection string.
`/health` staying up while `/ready` fails is correct: the process is alive, a
dependency is not.

---

## Routine maintenance

The worker handles these automatically:

| Job | Schedule | Purpose |
|---|---|---|
| `reconcile-schedules` | every 5 min | Repair scheduled content with a missing queue job; flag stuck publications |
| `refresh-tokens` | hourly | Renew connections nearing expiry; mark unrefreshable ones EXPIRED |
| `expire-opportunities` | hourly | Expire stale opportunities; decay trends |
| `purge-oauth-states` | every 30 min | Delete expired OAuth state rows |
| `sweep-metrics` | every 6 hours | Re-read metrics for posts published in the last 14 days |

Confirm they are registered after a deploy:

```bash
docker compose -f docker-compose.production.yml logs worker | grep "Scheduled:"
```

### Manual attention

- **Check `LINKEDIN_API_VERSION` quarterly.** Sunsets are announced but easy to
  miss.
- **Review approved claims periodically.** Claims with an `expiresAt` stop being
  valid; content grounded on them starts requiring review.
- **Watch `AuditLog` growth.** It is never pruned automatically, deliberately —
  set a retention policy that matches your compliance requirements.

---

## Tracing an incident

Every response carries `X-Request-Id`. From one id:

```sql
-- What the API did
SELECT * FROM "AuditLog" WHERE metadata->>'requestId' = '<id>';

-- Which agents ran
SELECT id, "agentName", status, model, "totalTokens", "latencyMs", error
FROM "AgentExecution" WHERE "correlationId" = '<id>';

-- Which tools they called
SELECT "toolName", status, "latencyMs", error
FROM "AgentToolCall"
WHERE "agentExecutionId" IN (
  SELECT id FROM "AgentExecution" WHERE "correlationId" = '<id>'
);

-- How a workflow progressed
SELECT "workflowName", status, "currentStep", steps, error
FROM "WorkflowExecution" WHERE "correlationId" = '<id>';
```

Worker logs carry the same `correlationId` on every line:

```bash
docker compose -f docker-compose.production.yml logs worker | grep '<id>'
```

---

## Emergency stop

**Stop all autonomous publishing immediately**, without touching drafts,
schedules or history:

```sql
UPDATE "Organization" SET "automationMode" = 'MANUAL', "autopilotEnabledAt" = NULL;
```

Takes effect on the next publishing job — the autopilot gate is re-evaluated in
the worker at publish time, reading current state.

**Stop all publishing including human-initiated:**

```bash
docker compose -f docker-compose.production.yml stop worker
```

Scheduled jobs remain in Redis and in the database. When the worker returns,
reconciliation re-enqueues anything missed. Use `docker compose stop`, not `kill`
— the 90-second grace period lets an in-flight publish settle rather than
becoming an unverifiable publication.
