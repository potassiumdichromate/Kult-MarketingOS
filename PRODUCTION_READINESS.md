# Production readiness

An honest account of what has been built, what has been verified, and what has
not. Nothing here is claimed on the basis of "it should work".

Last updated: 2026-08-28

---

## Summary

**The application is complete and runs end to end.** API, worker and web all
boot, connect to real PostgreSQL and Redis, and serve.

**It has not been deployed, and no integration has touched a live provider
account.** The Docker images are written and the API image builds, but the
containers have never been run together, and no OAuth flow, publish, metric read
or AI generation has executed against real credentials.

Do not treat this as production-proven. Treat it as a complete implementation
that now needs a staging environment and a first real connection.

---

## Verified

Executed and observed, not assumed.

| Area | Evidence |
|---|---|
| Typecheck | All 6 packages and 3 apps compile with **zero errors** |
| Unit tests | **58 passing** — RBAC, idempotency, platform limits, state machine, autopilot gating, AES-256-GCM, SSRF, error sanitisation |
| Integration tests | **7 passing** against real PostgreSQL 17 and Redis 7 |
| Migrations | Applied cleanly to real PostgreSQL 17 — **48 tables** |
| Cosine function | Verified on all edge cases: identical=1, orthogonal=0, dimension mismatch=0, zero vector=0 |
| API boot | `/health` ok, `/ready` reports database and redis ok |
| Auth enforcement | Unauthenticated request returns 401 with the documented envelope and a `requestId` |
| Worker boot | 6 queues consuming, 11 agents + 5 workflows synced to the database, 5 schedulers registered in Redis |
| Web build | 23 routes built; every route in the specification exists |
| Web serving | All routes return 200; Tailwind tokens compiled (`--color-primary:#ad36f2`, Sora) |
| Compose | `docker compose config` validates |
| Clean CI install | `CI=true pnpm install --frozen-lockfile` succeeds from an empty `node_modules` |

### The double-publish guarantee

The most important property, tested directly against the database:

- A second `Publication` insert with the same idempotency key is **rejected by
  the unique constraint** — verified.
- Changing `contentVersion` produces a different key, so an edited-and-reapproved
  piece is genuinely publishable again — verified.
- The Redis lock grants to exactly one holder — verified.
- A stale holder whose lock expired **cannot release a lock someone else now
  owns** — verified.
- The lock is released even when the guarded operation throws — verified.
- Contention reports rather than running the critical section twice — verified.

---

## Not verified

Stated plainly.

| Area | Status |
|---|---|
| **Docker images** | The **API image builds** through every stage and exports successfully. The worker, web and migrate images have **never been built**. |
| **Containers** | Never run. The stack has not been started via compose. |
| **nginx** | Config is written but has never been loaded by nginx. |
| **Social OAuth** | No connect, callback, publish, refresh or metric read has run against a real X, Instagram or LinkedIn account. |
| **AI agents** | No agent has run against a real OpenAI key. No prompt has produced a real generation. |
| **Privy login** | No real sign-in. Smoke tests used a placeholder app ID. |
| **Object storage** | No S3-compatible provider configured or exercised. |
| **API route tests** | No Supertest suite. |
| **E2E** | No Playwright suite. |
| **Load / performance** | Never measured. |
| **Penetration testing** | None. |

### On the Docker build

The API image build reached `naming to docker.io/library/kult-marketing-api` and
exported all layers successfully. Docker Desktop's backend then crashed during
the final unpack and could not be restarted — the Windows service requires
elevation unavailable in this environment.

So: the API Dockerfile is **proven to build**. The other three are written to the
same pattern but are **unproven**. Build all four before deploying.

---

## Security checklist

| Control | Status |
|---|---|
| No secrets committed | ✅ `.env` gitignored; `.env.example` has no real values |
| No tokens logged | ✅ Double redaction: pino redact paths + `redactSecrets()` |
| OAuth state CSRF protection | ✅ Single-use, bound to org/user/provider, 10-min expiry, consumed by conditional update |
| PKCE for X | ✅ 32-byte verifier, S256, stored encrypted |
| Tenant isolation | ✅ `scoped()` throws when unscoped; cross-tenant reads return 404 not 403 |
| Role authorization | ✅ Global guards; nesting enforced by test |
| API rate limits | ✅ Application limiter + nginx edge limits |
| Request validation | ✅ Zod on every route; unknown keys stripped |
| SSRF protection | ✅ Scheme/port allowlists, DNS pre-resolution, all blocked ranges, per-hop redirect revalidation |
| Encrypted OAuth tokens | ✅ AES-256-GCM, tamper-detecting, never returned by any API |
| Security headers | ✅ Helmet on API, full set at nginx |
| CORS allowlist | ✅ Explicit; unlisted origins rejected, not reflected |
| Database indexes | ✅ On `organizationId`, `createdAt`, `status`, `provider`, `scheduledAt`, `campaignId`, `contentId` |
| Migrations | ✅ Versioned; `db push` unreachable in production |
| Idempotent publishing | ✅ Unique constraint + lock + ambiguity quarantine |
| Job retries | ✅ Exponential backoff; 4xx auth errors never retried |
| Health checks | ✅ `/health` liveness, `/ready` dependency checks |
| Structured logs | ✅ JSON with correlation ids throughout |
| Audit logs | ✅ Every security-relevant action, secrets redacted |
| Backup documentation | ✅ [RUNBOOK.md](docs/RUNBOOK.md) |
| Deployment documentation | ✅ [DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Environment validation | ✅ Fails fast with a complete problem list |
| Test suite passing | ✅ 65 tests |
| Production build passing | ✅ All packages, API, worker, web |
| HTTPS | ⚠️ nginx configured; **never exercised** |
| Webhook validation | ⚠️ **No webhook receivers implemented.** Model exists, nothing wired |
| CSRF tokens | ⚠️ Not needed today — bearer tokens in headers, no cookie auth. Revisit if cookies are ever introduced |
| Error tracking | ⚠️ `SENTRY_DSN` supported; **never connected** |
| Dead-letter handling | ⚠️ BullMQ retains failed jobs 14 days; **no dedicated DLQ or alerting** |

---

## External prerequisites

None of these are code. All must be obtained before the corresponding feature
works.

### Required to run at all

| | |
|---|---|
| **Privy app** | `PRIVY_APP_ID` + `PRIVY_APP_SECRET`. Add the web origin to allowed domains. Configure login methods in the dashboard |
| **OpenAI API key** | With access to the four configured models |
| **PostgreSQL 15+** | Managed or self-hosted |
| **Redis 7+** | Eviction policy **must** be `noeviction` |
| **Encryption key** | `openssl rand -hex 32`. Losing it destroys every stored token |

### Required per integration

| Provider | Needs | Approval required |
|---|---|---|
| **X** | Developer project, OAuth 2.0 confidential client, exact redirect URI | Paid tier for research (recent search); Enterprise for quote posts |
| **Instagram** | Meta app with Instagram product, Business Login configured | **Professional (Business/Creator) account** — a personal account cannot be published to by any official API |
| **Instagram media** | `STORAGE_PUBLIC_BASE_URL` pointing at publicly readable storage | Instagram fetches media by URL; there is no upload path |
| **LinkedIn** | Developer app, "Share on LinkedIn" + "Sign In with OpenID Connect" products | Partner status for refresh tokens; `r_member_social` for metrics; Community Management API for company pages |

### Optional

| | |
|---|---|
| **Object storage** | S3-compatible. Required for uploads and for Instagram publishing |
| **Reddit** | Script app credentials + descriptive User-Agent |
| **YouTube** | Data API v3 key |
| **Sentry** | DSN |

### Genuinely unavailable

**Google Trends** has no official public API. It is permanently reported as
unavailable with an explanation rather than scraped. There is no variable that
enables it.

---

## Known provider limitations

Each is detected at runtime and surfaced with the exact fix. See
[SOCIAL-INTEGRATIONS.md](docs/SOCIAL-INTEGRATIONS.md).

- **LinkedIn refresh tokens** are partner-gated. Without partner status, members
  reconnect every 60 days. Not faked.
- **LinkedIn post metrics** need `r_member_social` (approval-only). Analytics
  reports a gap, never zeros.
- **LinkedIn media** needs the Images/Videos API for an asset URN. Not
  implemented — publishing **fails** rather than silently dropping media from
  approved content.
- **LinkedIn organic carousels** do not exist; sponsored only.
- **LinkedIn versions sunset annually.** `202508` was sunset 2026-08-17. Default
  is `202608`. **Check before every deployment.**
- **Instagram** requires a professional account and public media URLs. Limited to
  **100 API posts per rolling 24 hours**; carousels max **10 children**.
- **Instagram stories** are not implemented.
- **X quote posts** require Enterprise. `non_public_metrics` not requested.
- **Reddit and Discord** can be drafted but not published.

---

## Before first production deploy

1. Build **all four** images. Only the API image has been proven to build.
2. Start the stack in staging and confirm health, readiness and worker startup.
3. Load `.env` with real credentials and confirm startup validation passes.
4. Sign in with a real Privy account end to end.
5. Connect **one** social account and inspect its capability report against what
   [SOCIAL-INTEGRATIONS.md](docs/SOCIAL-INTEGRATIONS.md) predicts.
6. Publish **one** low-stakes post and verify the `Publication` row, the
   provider id, and the audit entry.
7. Deliberately re-queue the same job and confirm it returns `ALREADY_PUBLISHED`
   without posting again.
8. Confirm metric collection produces a snapshot 15 minutes later.
9. Run one research collection and confirm trends carry real source evidence.
10. Confirm `LINKEDIN_API_VERSION` is current.
11. Verify the encryption key is backed up **separately** from database backups.
12. Take and **restore** one database backup before relying on the system.

Step 7 is the one most worth doing deliberately. It is the guarantee the whole
publishing design exists to provide, and the only way to be certain it holds in
your environment is to try to break it.
