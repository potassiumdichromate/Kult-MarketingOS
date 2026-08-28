# Social integrations

What each provider can and cannot do, verified against current official
documentation, plus the external approvals you need before anything works.

Everything below was checked against the providers' own docs in August 2026. No
capability is claimed that the current official API does not support.

---

## The rule this codebase follows

If a provider cannot do something, the adapter raises
`UnsupportedCapabilityError` carrying the exact requirement, the API returns it
as `UNSUPPORTED_CAPABILITY`, and the Integrations screen shows it verbatim.

Nothing is silently skipped, and nothing pretends to succeed. If media cannot be
attached, publishing **fails** rather than posting the text alone — publishing
approved content in a different shape than approved is worse than not publishing.

---

## X (Twitter)

### Setup

1. Create a project and app in the X developer portal.
2. Set up **OAuth 2.0** with **Confidential client** (you need the client secret).
3. Register the callback URL **exactly**:
   `https://api.kult.games/api/v1/integrations/x/callback`
4. Set `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`.

### Flow

OAuth 2.0 Authorization Code **with PKCE**.

| Step | Endpoint |
|---|---|
| Authorize | `GET https://x.com/i/oauth2/authorize` |
| Token | `POST https://api.x.com/2/oauth2/token` |
| Revoke | `POST https://api.x.com/2/oauth2/revoke` |

Scopes requested: `tweet.read`, `tweet.write`, `users.read`, `media.write`,
`offline.access`.

`offline.access` is what makes a refresh token available. **Access tokens expire
after two hours**, so without it the connection needs manual reconnection
constantly. The capability report says so explicitly if it was not granted.

### What works

- Single posts — `POST /2/tweets`
- Threads — sequential posts chained with `reply.in_reply_to_tweet_id`
- Media — chunked upload via `POST /2/media/upload` (INIT → APPEND → FINALIZE →
  STATUS), up to 4 items on the first post
- Metrics — `public_metrics`: impressions, likes, replies, reposts, bookmarks
- Token refresh — automatic, with a 10-minute margin before expiry

### What does not

- **Quote posts.** `quote_tweet_id` requires an X Enterprise plan. Reported as an
  unavailable capability rather than attempted.
- **`non_public_metrics` and `organic_metrics`.** Gated behind access levels this
  application cannot assume. Only `public_metrics` is requested, so a metric read
  degrades gracefully instead of failing outright.

### Partial thread failures

If a thread fails partway, some posts are genuinely live. The adapter surfaces
the ids that were published in the error, and the worker records them on the
`Publication` rather than pretending nothing happened.

---

## Instagram

Uses **Instagram Login** (Business Login for Instagram) and the Instagram
Content Publishing API. Graph host is `graph.instagram.com`.

### Setup

1. Create a Meta app and add the Instagram product.
2. Configure Business Login for Instagram.
3. Register the redirect URI exactly:
   `https://api.kult.games/api/v1/integrations/instagram/callback`
4. Set `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`.
5. **Set `STORAGE_PUBLIC_BASE_URL`** — see below. Without it Instagram publishing
   cannot work at all.

### Flow

| Step | Endpoint |
|---|---|
| Authorize | `GET https://www.instagram.com/oauth/authorize` |
| Short-lived token | `POST https://api.instagram.com/oauth/access_token` |
| Long-lived token | `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` |
| Refresh | `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` |

Scopes: `instagram_business_basic`, `instagram_business_content_publish`.

The short-lived token is immediately exchanged for the 60-day long-lived token,
and **only the long-lived token is stored**. Refresh uses the token itself —
there is no separate refresh token — and requires the current token to be at
least 24 hours old.

### Two hard requirements

**1. A professional account.** Instagram's Content Publishing API publishes only
to Business or Creator accounts. A personal account cannot be published to
through *any* official API. The adapter reads `account_type` and reports:

> The connected account type is "PERSONAL". Instagram's Content Publishing API
> only publishes to professional accounts. Convert the account to a Business or
> Creator account in the Instagram app, then reconnect it here.

**2. Publicly reachable media URLs.** Instagram builds a media container by
**fetching a URL you supply**. There is no binary upload path. If
`STORAGE_PUBLIC_BASE_URL` is unset, the capability report says:

> Instagram builds a media container by fetching a publicly reachable URL; it
> accepts no direct binary upload. Set STORAGE_PUBLIC_BASE_URL to a publicly
> readable bucket or CDN origin.

Publishing is refused with that message rather than failing obscurely inside Meta.

### What works

- Single image and video/reel posts — `POST /<IG_ID>/media` then
  `POST /<IG_ID>/media_publish`
- Carousels — up to **10 children** (documented limit), created individually then
  combined
- Container readiness polling, because video and carousel containers process
  asynchronously and publishing before `FINISHED` errors
- Insights — reach, likes, comments, shares, saved, views

### Documented rate limit

**100 API-published posts per rolling 24 hours.** A carousel counts as one post.
Recorded in `PROVIDER_PUBLISHING_LIMITS`.

### What does not

- **Stories.** Not implemented by this integration; reported as unavailable.
- **Token revocation.** Instagram Login exposes no revocation endpoint. The
  connection is removed locally; a member revokes app access from Instagram's own
  settings.

---

## LinkedIn

The most constrained of the three, and the one where limits are most likely to
surprise.

### Setup

1. Create a LinkedIn developer application.
2. Request the **Share on LinkedIn** and **Sign In with LinkedIn using OpenID
   Connect** products.
3. Add the redirect URL exactly:
   `https://api.kult.games/api/v1/integrations/linkedin/callback`
4. Set `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`.
5. Check `LINKEDIN_API_VERSION` — see the version warning below.

### Flow

| Step | Endpoint |
|---|---|
| Authorize | `GET https://www.linkedin.com/oauth/v2/authorization` |
| Token | `POST https://www.linkedin.com/oauth/v2/accessToken` |
| Member identity | `GET https://api.linkedin.com/v2/userinfo` |
| Create post | `POST https://api.linkedin.com/rest/posts` |

Scopes: `openid`, `profile`, `email`, `w_member_social`.

Every REST call requires both `LinkedIn-Version: YYYYMM` and
`X-Restli-Protocol-Version: 2.0.0`. A successful post returns **201 with the post
URN in the `x-restli-id` response header**, not in the body.

### Version sunset — check this before every deployment

LinkedIn sunsets a versioned API roughly a year after release. **Version `202508`
was sunset on 2026-08-17.** The default is `202608`.

An expired version fails every LinkedIn call. Check the LinkedIn migrations page
and update `LINKEDIN_API_VERSION` on a schedule, not on an incident.

### Three real limitations

**1. Refresh tokens are partner-gated.** LinkedIn states that programmatic
refresh tokens are available only to a limited set of partners. Access tokens
last 60 days. If the token response carries no refresh token,
`refreshToken()` raises:

> LinkedIn issued no refresh token for this connection. Programmatic refresh
> tokens are available only to approved LinkedIn partner applications. The member
> must reconnect their LinkedIn account when the 60-day access token expires.

The connection is marked `EXPIRED` and a notification asks for reconnection. It
does not pretend the refresh happened.

**2. Per-post metrics need `r_member_social`**, which LinkedIn documents as
restricted to approved applications. Without it, `getMetrics()` raises
`UnsupportedCapabilityError`, the connection is marked as unable to read
metrics so the sweep stops asking, and **analytics reports a gap rather than
zeros**.

**3. Company-page posting needs `w_organization_social`**, which requires
additional LinkedIn product access (Community Management API) *and* an
ADMINISTRATOR, CONTENT_ADMIN or DIRECT_SPONSORED_CONTENT_POSTER role on the page.
Only member posting is implemented. The capability report says:

> Additional LinkedIn API access is required.

### Media

Not implemented. Attaching media to a LinkedIn post requires uploading through
the Images or Videos API to obtain an asset URN. Rather than silently dropping
the media, publishing **fails** with:

> Publishing media to LinkedIn requires uploading the asset through the LinkedIn
> Images or Videos API to obtain an asset URN. This integration publishes text
> posts only.

### Also unavailable

- **Organic carousels.** LinkedIn supports carousel posts for sponsored content
  only.
- **Token revocation.** No OAuth revocation endpoint for member tokens.

---

## Reddit and Discord

Both appear as content types so drafts can be written and exported, and both are
marked **not publishable** with the reason:

- **Reddit** — available as a research source only. No publishing integration is
  configured.
- **Discord** — publishing needs a bot token and channel configuration this
  deployment does not define.

---

## Research sources

Separate from publishing. Each reports availability with the reason and the
variables that would enable it.

| Source | Requires | Notes |
|---|---|---|
| WEB | `AI_WEB_SEARCH_ENABLED` | Hosted web search. **Only citation-backed URLs are kept** — a URL the model merely wrote in prose is discarded, because those can be fabricated |
| RSS / NEWS | nothing | Public feeds; RSS 2.0 and Atom |
| REDDIT | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` | App-only OAuth. Reddit requires a descriptive User-Agent |
| YOUTUBE | `YOUTUBE_API_KEY` | Data API v3. Channels can hide statistics, so those metrics stay absent rather than zero |
| X | `X_BEARER_TOKEN` | Recent search requires a **paid** X API tier |
| CUSTOM_URL | nothing | Specific pages; fetched through the SSRF guard |
| GOOGLE_TRENDS | — | **Permanently unavailable.** Google publishes no official public Trends API |

### Google Trends

Listed in the UI as unavailable with an explanation rather than hidden or
scraped:

> Google does not offer an official public Google Trends API, so this source
> cannot be collected. Trend velocity is derived instead from the RSS, Reddit,
> YouTube, X and web search sources.

Scraping an undocumented internal endpoint would be unreliable and against
Google's terms.

---

## Capability reporting

Every connection stores a resolved capability report:

```json
{
  "publishableContentTypes": ["X_POST", "X_THREAD"],
  "unavailable": {
    "quotePost": "Quote posting requires an X Enterprise plan.",
    "mediaUpload": "The \"media.write\" scope was not granted..."
  },
  "grantedScopes": ["tweet.read", "tweet.write", "users.read"],
  "missingScopes": ["media.write", "offline.access"],
  "canReadMetrics": true
}
```

Resolved at connection time and refreshed by **Check** on the Integrations
screen. The publishing path consults `publishableContentTypes` before queueing,
so an impossible publish is refused early with an actionable message rather than
failing at the provider.
