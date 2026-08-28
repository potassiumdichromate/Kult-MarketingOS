# API

REST, prefixed `/api/v1`. The live OpenAPI schema is at
`/api/v1/openapi.json` and its explorer at `/api/v1/docs`.

---

## Authentication

Every route except `/health`, `/ready`, `GET /me`, `POST /organizations` and the
OAuth callbacks requires a Privy access token:

```http
Authorization: Bearer <privy access token>
```

The API verifies the token with Privy's server SDK, confirms it was minted for
this application, and derives the user from its DID. **Identity is never taken
from a request body, query or header.**

### Selecting an organization

```http
X-Organization-Id: <organization id>
```

Optional. Selects among organizations the caller **already belongs to**; it
cannot grant access to one they do not. Omitted, the first membership is used.

### First call

A brand-new Privy user has no local record yet. `GET /api/v1/me` provisions it
and is the only route that works before then — every other authenticated route
returns 401 until it has been called once.

Passing `X-Privy-Id-Token` enriches the profile with linked-account details.
Optional; enrichment failure never blocks a valid session.

---

## Errors

One envelope everywhere:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request payload failed validation.",
    "requestId": "e1a4c7f2-...",
    "issues": [{ "path": "scheduledAt", "message": "Pick a time later than now." }]
  }
}
```

Branch on `code`, never on message text.

| Code | Status | Meaning |
|---|---|---|
| `AUTHENTICATION_REQUIRED` | 401 | No credentials |
| `AUTHENTICATION_FAILED` | 401 | Token invalid, expired, or for another app |
| `FORBIDDEN` | 403 | Role lacks the permission |
| `VALIDATION_FAILED` | 400 | Payload rejected; carries `issues[]` |
| `NOT_FOUND` | 404 | Missing **or belongs to another tenant** |
| `CONFLICT` | 409 | Illegal state transition |
| `RATE_LIMITED` | 429 | Carries `Retry-After` |
| `PROVIDER_ERROR` | 502 | Downstream provider failed |
| `AI_PROVIDER_ERROR` | 502 | Model provider failed |
| `PUBLISHING_FAILED` | 502 | Publish failed |
| `UNSUPPORTED_CAPABILITY` | 422 | Provider genuinely cannot do this |
| `NOT_CONFIGURED` | 503 | Deployment lacks required configuration |
| `INTERNAL_ERROR` | 500 | Unexpected; generic message in production |

`requestId` is on every response and echoed as `X-Request-Id`. It threads through
API logs, agent executions, workflow executions, audit rows and publications —
quote it in any bug report.

### Two codes worth handling specially

**`UNSUPPORTED_CAPABILITY`** carries the exact external requirement:

```json
{
  "error": {
    "code": "UNSUPPORTED_CAPABILITY",
    "message": "LinkedIn cannot perform \"post metrics\". ...",
    "provider": "LinkedIn",
    "capability": "post metrics",
    "requirement": "Retrieving engagement metrics for a member post requires the \"r_member_social\" permission, which LinkedIn grants only to approved applications."
  }
}
```

**`NOT_CONFIGURED`** names the variables to set:

```json
{
  "error": {
    "code": "NOT_CONFIGURED",
    "message": "Object storage is not configured on this deployment. ...",
    "requiredVariables": ["STORAGE_ENDPOINT", "STORAGE_REGION", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY", "STORAGE_SECRET_KEY"]
  }
}
```

---

## Pagination

List endpoints use opaque cursors, not offsets — research and content tables
receive continuous writes, so offsets would skip or repeat rows.

```
GET /api/v1/content?limit=25&cursor=MjAyNi0wOC0yOFQxMDoxMjozM1o...
```

```json
{ "items": [...], "nextCursor": "...", "hasMore": true }
```

---

## Endpoints

Permissions in brackets. See `packages/shared/src/rbac.ts` for the full matrix.

### Identity and organization

| Method | Path | Permission |
|---|---|---|
| `GET` | `/me` | public (verifies token itself) |
| `POST` | `/organizations` | public (verifies token itself) |
| `GET` | `/organization` | `organization:read` |
| `PATCH` | `/organization` | `organization:update` |
| `GET` | `/organization/members` | `members:read` |
| `POST` | `/organization/members` | `members:invite` |
| `PATCH` | `/organization/members/:id` | `members:update_role` |
| `DELETE` | `/organization/members/:id` | `members:remove` |

Adding a member requires them to have signed in with Privy at least once — this
application never creates accounts.

### Research, trends, niches, opportunities

| Method | Path | Permission |
|---|---|---|
| `GET` | `/research` | `research:read` |
| `GET` | `/research/sources` | `research:read` |
| `POST` | `/research/sources` | `research:run` |
| `PATCH`/`DELETE` | `/research/sources/:id` | `research:run` |
| `POST` | `/research/run` | `research:run` |
| `GET` | `/research/runs/:id` | `research:read` |
| `GET` | `/trends`, `/trends/:id` | `research:read` |
| `GET` | `/niches` | `research:read` |
| `POST` | `/niches/discover` | `research:run` |
| `GET` | `/opportunities`, `/opportunities/:id` | `opportunities:read` |
| `POST` | `/opportunities` | `opportunities:write` |
| `PATCH` | `/opportunities/:id` | `opportunities:write` |

`GET /research/sources` returns configured sources **and** the availability of
every source type this deployment supports, including unavailable ones with the
reason.

`GET /trends/:id` separates `evidence` (real research items with real URLs) from
`rationale` (AI-written explanation). The rationale is never evidence.

### Content

| Method | Path | Permission |
|---|---|---|
| `GET` | `/content`, `/content/:id` | `content:read` |
| `POST` | `/content` | `content:write` |
| `PATCH` | `/content/:id` | `content:write` |
| `GET` | `/content/:id/versions` | `content:read` |
| `POST` | `/content/:id/generate` | `ai:generate` |
| `POST` | `/content/:id/assist` | `ai:generate` |
| `POST` | `/content/:id/submit` | `content:write` |
| `POST` | `/content/:id/approve` | `content:approve` |
| `POST` | `/content/:id/reject` | `content:approve` |
| `POST` | `/content/:id/schedule` | `content:schedule` |
| `POST` | `/content/:id/publish` | `content:publish` |
| `POST` | `/content/:id/cancel` | `content:write` |
| `DELETE` | `/content/:id` | `content:delete` |

Notes:

- **A substantive edit creates a new version and returns approved or scheduled
  content to `DRAFT`** — the approval applied to the previous text. It also
  cancels any queued publishing job for the old version.
- Illegal transitions return 409 with the reason. The state machine lives in
  `packages/shared/src/domain.ts`.
- `/publish` returns as soon as the job is queued; the worker performs it under
  a lock with an idempotency key.
- Published content cannot be edited or deleted — its publication record is
  retained for audit.
- `/assist` operations: `REWRITE`, `SHORTEN`, `EXPAND`, `CHANGE_TONE`,
  `GENERATE_CTA`, `GENERATE_HOOKS`, `BRAND_CHECK`, `FACT_CHECK`. Results are
  returned for review, not written to the item.

### Campaigns

| Method | Path | Permission |
|---|---|---|
| `GET` | `/campaigns`, `/campaigns/:id` | `campaigns:read` |
| `POST` | `/campaigns` | `campaigns:write` |
| `PATCH` | `/campaigns/:id` | `campaigns:write` |
| `POST` | `/campaigns/:id/generate` | `ai:generate` |
| `POST` | `/campaigns/:id/activate` | `campaigns:activate` |
| `POST` | `/campaigns/:id/pause` | `campaigns:activate` |

`/generate` is asynchronous and returns a workflow id. Calendar entries become
real, editable `ContentItem` drafts. A campaign with no content cannot be
activated.

### Integrations

| Method | Path | Permission |
|---|---|---|
| `GET` | `/integrations` | `integrations:read` |
| `POST` | `/integrations/:provider/connect` | `integrations:connect` |
| `GET` | `/integrations/:provider/callback` | public (state-validated) |
| `POST` | `/integrations/:provider/validate` | `integrations:read` |
| `POST` | `/integrations/:provider/disconnect` | `integrations:disconnect` |

`GET /integrations` lists **all** providers including unconfigured ones, with the
variables required to enable them, and a capability report per connection.
**Tokens are never returned.**

The callback is public because the provider redirects a browser with no bearer
token; authenticity comes from the single-use `state` bound server-side.

### Knowledge

| Method | Path | Permission |
|---|---|---|
| `GET` | `/knowledge` | `knowledge:read` |
| `GET` | `/knowledge/search` | `knowledge:read` |
| `PUT` | `/knowledge/profile` | `knowledge:write` |
| `POST` | `/knowledge` | `knowledge:write` |
| `POST` | `/knowledge/url` | `knowledge:write` |
| `POST` | `/knowledge/text` | `knowledge:write` |
| `POST` | `/knowledge/upload` | `knowledge:write` |
| `DELETE` | `/knowledge/documents/:id` | `knowledge:delete` |
| `DELETE` | `/knowledge/:type/:id` | `knowledge:delete` |

`/url` fetches through the SSRF-guarded client. `/upload` requires object storage
and accepts only text formats whose content can genuinely be extracted — binary
formats are refused rather than stored and never indexed.

### Analytics, insights, agents

| Method | Path | Permission |
|---|---|---|
| `GET` | `/dashboard` | `organization:read` |
| `GET` | `/analytics/overview` | `analytics:read` |
| `GET` | `/analytics/posts` | `analytics:read` |
| `GET` | `/analytics/campaigns` | `analytics:read` |
| `GET` | `/analytics/platforms` | `analytics:read` |
| `POST` | `/analytics/review` | `analytics:read` |
| `GET` | `/insights` | `analytics:read` |
| `POST` | `/insights/:id/decide` | `campaigns:write` |
| `GET` | `/agents` | `agents:read` |
| `GET` | `/agents/executions` | `agents:read` |
| `GET` | `/agents/executions/:id` | `agents:read` |

**Metrics a provider does not report are `null`, never `0`.**
`/analytics/overview` includes a `metricGaps[]` array naming each platform and
why its metrics are unavailable.

`/insights/:id/decide` is always a human decision — nothing applies an insight
automatically.

### Copilot

| Method | Path | Permission |
|---|---|---|
| `POST` | `/copilot/threads` | `ai:copilot` |
| `GET` | `/copilot/threads` | `ai:copilot` |
| `GET` | `/copilot/threads/:id` | `ai:copilot` |
| `POST` | `/copilot/threads/:id/messages` | `ai:copilot` |

Threads are private to the user who created them.

**Side-effecting tools are confirmation-gated.** A message that would publish,
schedule, delete or change automation mode returns a proposal instead of acting:

```json
{
  "message": { "content": "Publishing this will post it publicly..." },
  "pendingConfirmations": [
    {
      "actionId": "publishContent_1a2b3c",
      "summary": "Publish content abc123 publicly, right now",
      "details": { "contentItemId": "abc123" }
    }
  ]
}
```

Send a follow-up with that id in `confirmedActionIds` to carry it out.
Confirming one proposal cannot authorise a different call — the id is derived
from the tool name and its arguments.

### Notifications and health

| Method | Path | Permission |
|---|---|---|
| `GET` | `/notifications` | `organization:read` |
| `POST` | `/notifications/read` | `organization:read` |
| `GET` | `/health` | public |
| `GET` | `/ready` | public |

`/health` is liveness and touches no dependency. `/ready` checks Postgres and
Redis, returning 503 with a per-dependency status when either is unavailable —
without disclosing a host, port or connection string.
