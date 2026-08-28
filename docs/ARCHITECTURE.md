# Architecture

How Kult Marketing OS is put together, and the reasoning behind the decisions
that would otherwise look arbitrary.

---

## Shape

Three processes over two data stores.

- **api** — NestJS. Authenticates, authorises, validates, reads and writes the
  database, and *enqueues* work. It never does long-running work itself.
- **worker** — BullMQ consumers. Research, generation, publishing, metric
  collection, and maintenance sweeps.
- **web** — Next.js. Entirely client-rendered behind authentication.

PostgreSQL is the source of truth. Redis is coordination only: every piece of
state it holds can be rebuilt from the database, which is what makes the
reconciliation sweep possible.

### Why the API never processes

Research across five providers takes minutes. Campaign generation is a
multi-minute reasoning task. Publishing waits on Instagram to finish processing
a video container. None of that belongs on an HTTP request.

So `POST /research/run` creates a `WorkflowExecution`, enqueues a job, and
returns an id to poll. The pattern is uniform: every slow operation returns a
handle to durable state rather than blocking.

---

## Package boundaries

Dependencies point one way. `config` and `shared` depend on nothing internal;
apps depend on packages; no package depends on an app.

```
config ─┐
shared ─┼─▶ database ─┬─▶ ai ──────┐
        │             │            ├─▶ api
        ├─▶ auth ─────┤            ├─▶ worker
        └─▶ integrations ──────────┘
                                     web ─▶ shared
```

`packages/shared` is deliberately pure — no I/O, no Prisma, no network. That is
what lets the web app import the same RBAC matrix, platform limits and content
state machine the API enforces, with no risk of drift and no server dependency
reaching the browser bundle.

`ai` depends on `integrations` for the `ResearchSourceAdapter` type, and the WEB
research adapter is *injected* into the research registry rather than
constructed there. Pointing the dependency that way avoids a cycle, since the
web adapter is powered by the model provider's hosted search.

---

## Data model

48 tables. The rules that matter:

**Every organization-owned row carries `organizationId` and is indexed on it.**
Repositories build `where` clauses through `scoped()`, and single-row reads go
through `requireInOrg()`, which treats a cross-tenant id exactly like a missing
one — a 404, never a 403, so the existence of another tenant's records is not
disclosed.

**Timestamps are UTC.** `Organization.timezone` is applied only at render time
and when analysing posting windows. Storing local times would make the calendar
wrong for anyone in another timezone.

**Secrets live only in `*Encrypted` columns.** OAuth access tokens, refresh
tokens and PKCE verifiers are sealed with AES-256-GCM. No API response returns
them, and `redactSecrets()` runs over anything heading for a log or audit row.

**Nulls mean "not measured".** `PostMetricSnapshot` columns are nullable
throughout. A provider that does not report impressions leaves the column null,
which is a different fact from zero impressions.

### Knowledge retrieval without a vector database

Brand knowledge is chunked, embedded, and stored as `Float[]`. Similarity search
ranks *inside PostgreSQL* using a `kult_cosine_similarity` function installed by
migration:

```sql
SELECT id, content,
       kult_cosine_similarity(embedding, $1::double precision[]) AS similarity
FROM "KnowledgeChunk"
WHERE "organizationId" = $2
ORDER BY similarity DESC
LIMIT $3
```

No extension, no external service, no per-query corpus load into Node. It is a
sequential scan over one organization's chunks, which is appropriate at
brand-knowledge scale — hundreds to low tens of thousands. If a tenant outgrows
that, the migration path is pgvector with an HNSW index, and the retrieval
interface does not change.

The tenant predicate is inside the SQL rather than applied afterwards, so a
ranking bug could never leak another tenant's knowledge.

---

## AI layer

### One gateway

Agents never construct an OpenAI client. `AIService` owns model selection by
tier (`default` / `fast` / `reasoning` / `embedding` / `image`), structured
output enforcement, bounded retries that distinguish transient from permanent
failures, and token accounting.

No model name appears anywhere else in the codebase. Changing a model is an
environment change.

### Agents are services, not prompts

Eleven agents, each with a declared input schema, output schema, model tier,
timeout, retry policy and tool list. `AgentRunner` writes an `AgentExecution`
row *before* the agent starts, so an agent that hangs or crashes still leaves a
trace rather than disappearing.

### Structured output, not parsing

Every generation goes through Zod + Structured Outputs. Optional values are
`.nullable()`, never `.optional()`, because strict schemas require every
property to be present — an omitted key is a violation while an explicit null is
not. A refusal or unparseable response raises `AIProviderError`; nothing is
salvaged with regex.

### The model proposes, code decides

This separation runs through the whole system:

| The model supplies | Code decides |
|---|---|
| Brand relevance, competition, saturation judgements | The trend score |
| A self-reported `requiresApproval` flag | The actual approval requirement |
| A claimed `supportedByKnowledgeBase` | Whether the claim matches an approved one |
| An explanation of a score | The score |

`assessApproval()` takes the model's risk assessment as one input among several
and can only ever *escalate* it. Nothing the model says can lower an approval
requirement.

### Prompt injection

Research items, competitor pages and uploaded documents are attacker-controlled.
They are wrapped in labelled `<untrusted-content>` delimiters, preceded by a
standing instruction that content inside is data. Any closing delimiter in the
payload is neutralised so content cannot terminate its own container.

The structural defence is what protects the model. `detectInjectionAttempt()`
exists for observability — flagged sources are logged so operators can see which
feeds are hostile — and never gates the pipeline.

Tool invocation is never driven by collected content. The copilot's tools are
called only in response to a user turn, and each re-checks permissions
server-side.

---

## Publishing

The one irreversible thing this system does, so it gets the most care.

```
job → idempotency key → settled? → lock → validate → autopilot gate
    → token refresh → mark PUBLISHING → Publication PENDING
    → provider call → settle → audit → notify → enqueue metrics
```

Three mechanisms prevent a double publish:

1. **Idempotency key** — `sha256(org, connection, content, contentVersion)` with
   a unique constraint on `Publication`. A `SUCCEEDED` row short-circuits, so a
   duplicate job, a double click, or a BullMQ retry after success are all no-ops.

2. **Distributed lock** — Redis `SET NX PX` with a token-checked Lua release, so
   a holder whose lock already expired cannot delete a lock someone else now
   owns.

3. **Ambiguity quarantine** — the hard case. A timeout or 5xx *during* the
   provider call may or may not have created a post. That cannot be resolved
   automatically, so the publication is recorded `NEEDS_VERIFICATION` and never
   retried. Silently retrying risks a duplicate; a stalled publication a human
   resolves is strictly better.

A stale-version guard covers the fourth case: a job whose content was edited
after queueing is skipped rather than publishing copy nobody approved.

### Reconciliation

Redis can lose state. Every five minutes the worker compares scheduled content
against the publishing queue and repairs three divergences: scheduled content
with no queue job, overdue content still marked scheduled, and content stuck in
`PUBLISHING` for over thirty minutes.

The third is *not* auto-retried — it is flagged for verification, for the same
reason as the ambiguity quarantine.

---

## Authentication and authorization

Privy authenticates. The API verifies the access token with Privy's server SDK,
cross-checks that the token was minted for this app, and derives the user from
its DID. The browser never asserts identity.

Organization and role come from the `OrganizationMember` row. An
`x-organization-id` header may *select* among organizations the caller belongs
to; it can never grant access to one they do not.

Guards run globally in order: rate limit → authenticate → authorise. A route is
protected unless it explicitly says `@Public()`, so a newly added endpoint is
safe by default rather than by remembering.

The permission matrix in `packages/shared/src/rbac.ts` is the single source of
truth, shared by API guards, the copilot tool layer, and the web app. The
frontend uses it only to hide controls; every decision is re-made server-side.

---

## Frontend

Client-rendered behind auth. There is no server-side data fetching because every
request needs a Privy token that only exists in the browser.

The provider tree mounts after hydration — Privy validates its app ID at
construction, which fails during static prerender.

TanStack Query owns server state. Mutations invalidate the specific keys their
write affects rather than clearing the cache, so the UI does not flicker back to
skeletons after every action.

---

## Observability

Every request gets a `requestId` — accepted from the client only if it looks
like an opaque id, so a caller cannot inject newlines into the log stream. It
threads through to agent executions, workflow executions, audit rows and
publications.

That makes the full trace answerable from one id:

```
user → request → workflow → agent → tool call → content → publication → provider
```

Worker logs are structured JSON with `queue`, `jobId`, `organizationId` and
`correlationId` on every line, with token-shaped keys redacted twice — once by
pino's redact paths and once by `redactSecrets()`, because a provider error body
can carry a token in a field name nobody anticipated.

`/health` is liveness and touches nothing. `/ready` checks Postgres and Redis
and names a failing dependency without disclosing a host, port or connection
string.
