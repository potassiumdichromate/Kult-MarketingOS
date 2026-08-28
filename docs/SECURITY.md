# Security

What this system defends against, how, and where the boundaries actually are.

---

## Authentication

Privy is the only identity provider. This application has no passwords, creates
no accounts, and has no registration form.

Every authenticated request carries a Privy access token as a bearer credential.
`PrivyAuthenticator.verifyAccessToken()` verifies it with Privy's official
server SDK and then **cross-checks `claims.appId` against the configured app
ID** — a validly-signed token minted for a different Privy application is
rejected. That check exists because a signature alone does not prove the token
was issued for us.

Setting `PRIVY_VERIFICATION_KEY` makes verification fully offline, with no
per-request network call. Without it the SDK fetches and caches the JWKS itself.

The identity token (`x-privy-id-token`) is optional and used only to enrich a
profile with linked-account details. Enrichment failure never blocks a valid
session.

**The browser never asserts who it is.** No route reads a user id from a body,
query or header.

---

## Authorization

Five roles, nested so each is a superset of the one below: `VIEWER` ⊂ `ANALYST`
⊂ `EDITOR` ⊂ `ADMIN` ⊂ `OWNER`. A test enforces that nesting, so a permission
cannot be granted to a lower role without also appearing in every higher one.

Two separations are deliberate:

- **`EDITOR` can write content but not approve it.** Approving your own work
  defeats the point of an approval step.
- **`automation:configure` is `ADMIN`+.** Enabling autopilot is a
  security-relevant configuration change, not an editing action.

Role assignment is constrained further: a member may only assign roles strictly
below their own, may never grant `OWNER`, may not change their own role, and may
not remove the last owner.

Guards are registered globally, so a new route is protected unless it explicitly
opts out with `@Public()`.

---

## Multi-tenancy

The strongest boundary in the system.

Organization membership is read from the database on every request. An
`x-organization-id` header selects among organizations the caller *already*
belongs to; a request naming one they do not is rejected.

Repositories build `where` clauses through `scoped()`, which throws if the
tenant id is missing rather than silently querying unscoped. Single-row reads go
through `requireInOrg()`.

**A cross-tenant read returns 404, not 403.** Returning "forbidden" would
confirm the record exists. This applies to content, campaigns, opportunities,
connections, agent executions and copilot threads.

Copilot tool schemas deliberately contain **no `organizationId` parameter**. The
model cannot name another tenant because the field does not exist; scope comes
from the authenticated context.

---

## Secrets at rest

OAuth access tokens, refresh tokens and PKCE verifiers are sealed with
**AES-256-GCM** before storage:

```
v1.<base64url iv>.<base64url authTag>.<base64url ciphertext>
```

- A 96-bit random nonce per encryption, so two identical tokens are not linkable.
- The GCM auth tag means a tampered ciphertext **fails to decrypt** rather than
  yielding garbage. Tests cover tampering with the ciphertext and with the tag.
- The version prefix makes key rotation possible without ambiguity.
- Failure messages never echo the plaintext or the OpenSSL error.

**No API response returns a token.** `SocialConnection` selects in the API
explicitly exclude the encrypted columns; the worker decrypts in exactly one
place (`lib/connections.ts`) and the plaintext never leaves the `TokenSet`.

### Encryption key

`ENCRYPTION_KEY` must decode to exactly 32 bytes (hex or base64), validated at
startup.

> **If this key is lost, every stored OAuth token is permanently unrecoverable.**
> There is no recovery path — that is the point of authenticated encryption.
> Every social account must be reconnected. Back the key up in a secret manager,
> **separately from database backups**, so a single compromise does not yield
> both.

---

## OAuth

**State is single-use and bound.** Every authorization creates an `OAuthState`
row tying the state value to an organization, a user, a provider and a ten
minute expiry. On callback the state is looked up, checked for expiry, and
**consumed with a conditional update** (`updateMany where consumedAt: null`)
before the code is exchanged — so a replayed callback cannot mint a second
connection even if the exchange is slow.

**PKCE for X.** A fresh 32-byte verifier per authorization, S256 challenge,
stored encrypted because it is a bearer credential between the two legs.

**The callback trusts nothing from the request.** It arrives as a browser
redirect with no bearer token, so the organization and user come entirely from
the persisted state row.

**No open redirect.** `sanitizeRedirectPath()` accepts only same-site absolute
paths — rejecting `//evil.com`, backslashes and control characters — and the
final redirect is constructed against the configured `WEB_URL`.

**Provider errors are not reflected.** The callback redirects with a fixed
reason code, never with provider-supplied text interpolated into the page.

---

## SSRF

Any URL from outside the application — a pasted RSS feed, a competitor page, a
knowledge-base URL — is fetched through `safeFetch()`. First-party provider APIs
use plain `fetch`, because their hosts are fixed in code.

Protections:

- Scheme allowlist: `http` and `https` only. `file:`, `gopher:` and `data:` are
  rejected.
- Port allowlist, blocking 22, 6379 and everything else non-standard.
- **DNS resolved before connecting**, with *every* returned address checked.
- Blocked ranges: loopback, private (10/8, 172.16/12, 192.168/16), link-local
  including **169.254.169.254**, CGNAT, benchmarking, multicast, "this network",
  and the IPv6 equivalents including `::1`, `fe80::/10`, `fc00::/7` and
  IPv4-mapped forms.
- Blocked hostnames: `localhost`, `*.localhost`, `*.internal`,
  `metadata.google.internal`.
- **Redirects are followed manually and each hop is re-validated**, so DNS
  rebinding across a redirect cannot bypass the first check.
- Response size and total time caps, with the body streamed and truncated rather
  than buffered whole.

Anything that is not a valid IP is treated as unsafe.

---

## AI security

**Untrusted content is structurally isolated.** Collected material is wrapped in
labelled delimiters with a standing instruction that it is data. Closing
delimiters inside the payload are neutralised so content cannot escape its
container.

**Injection detection is observability, not a gate.** The structural defence
protects the model; detection exists so operators can see which sources are
hostile.

**The model cannot reach anything it should not.** It has no shell, no arbitrary
HTTP, no secret access, and no ability to change permissions or configuration
outside the confirmation-gated `changeAutomationMode` tool.

**Every tool call re-checks authorization** against the caller's role at
invocation time. The model asking to call a tool proves nothing.

**Side-effecting tools are confirmation-gated.** `publishContent`,
`scheduleContent`, `deleteContent`, `changeAutomationMode`, `createCampaign` and
`generateContent` return a *proposal* with a stable `actionId` derived from the
tool name and its arguments. The action runs only when that id arrives in a
later request's `confirmedActionIds`. Confirming one proposal cannot authorise a
different call.

This is what stops a vague question from publishing a post.

---

## Content safety

The approval decision is made server-side and can only escalate:

- Claims are matched against `ApprovedClaim` rows by normalised token overlap
  with a high threshold. **Matching is deliberately conservative** — a near-miss
  counts as unverified, because over-reporting costs a review while
  under-reporting publishes a false statement.
- Regex policy patterns flag token claims, financial claims, partnerships,
  regulatory content, political content and competitor accusations.
- Forbidden phrases are matched literally and escalate risk to `CRITICAL`.

**Autopilot** requires *all* of: mode is `AUTOPILOT`, risk is `LOW`, no flagged
topics, content type on the allowlist, no unverified claims, connection
`ACTIVE`, and under the daily cap. It is disabled by default and the allowlist
starts empty, so enabling the mode alone publishes nothing.

The gate is re-evaluated in the worker at publish time, reading verification
state from the database — not trusting anything recorded earlier.

---

## Transport and headers

nginx terminates TLS 1.2/1.3 and sets HSTS, `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` and
`X-Robots-Tag: noindex`.

The API additionally sets Helmet headers including a restrictive CSP
(`default-src 'none'`), since it serves only JSON.

**CORS is an explicit allowlist** built from `WEB_URL` plus
`CORS_ADDITIONAL_ORIGINS`. An unlisted origin is rejected outright rather than
reflected. nginx deliberately adds no CORS headers — two sources of truth would
eventually disagree.

`trust proxy` is set to 1 so `req.ip` is the real client rather than the nginx
address. Without it, audit logs would record the proxy for every action.

Postgres and Redis publish no host ports in the production compose file.

---

## Audit

Every security-relevant action is recorded with actor, actor type,
organization, resource, IP, user agent and timestamp: logins, organization and
role changes, integration connect/disconnect/validate, content
create/approve/reject/schedule/publish/delete, campaign activation, automation
mode changes, research runs, and insight decisions.

Metadata passes through `redactSecrets()` before writing, so a caller cannot
cause a token to be persisted by putting one in a field an audit record happens
to capture.

Audit writes never break the operation they record — a failure is logged and
swallowed, because losing the action is worse than losing its audit entry.

---

## Error handling

Responses use one envelope:

```json
{ "error": { "code": "...", "message": "...", "requestId": "..." } }
```

Stack traces are never returned. In production an unexpected exception becomes a
generic `INTERNAL_ERROR`, so an accidental `throw new Error(connectionString)`
cannot leak.

Provider messages pass through `sanitizeProviderMessage()` before being stored
or logged, stripping bearer tokens, `access_token=`, `refresh_token`,
`client_secret` and `code_verifier` in both query-string and JSON forms.
Providers do sometimes echo the request, including the Authorization header.

---

## Known gaps

Stated plainly rather than omitted.

- **No CSRF token.** Not currently needed: authentication is a bearer token in a
  header, never a cookie, so a cross-site form post carries no credentials. This
  changes the moment any cookie-based auth is introduced.
- **No webhook receivers are implemented.** The `WebhookEvent` model and
  signature-validation intent exist, but no provider webhook is wired up. When
  one is, signature validation is mandatory before processing.
- **API keys are modelled but not issued.** The `ApiKey` table stores a sha256
  hash and a display prefix; no endpoint creates or accepts one yet.
- **No rate limiting per organization**, only per IP at nginx and per IP in the
  application. A single tenant could consume a disproportionate share.
- **Reddit and Discord content can be drafted but not published.** Both are
  reported as not publishable with the reason.
- **Nothing has been penetration tested**, and no OAuth flow has run against a
  real provider account.
