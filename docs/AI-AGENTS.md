# AI agents

Eleven agents, each an explicit service with declared schemas, a model tier, a
timeout and a retry policy — not a prompt buried in a route handler.

---

## The governing principle

**The model proposes; code decides.**

| The model supplies | Code decides |
|---|---|
| Brand relevance, competition, saturation judgements | The trend score |
| A self-reported `requiresApproval` | The actual approval requirement |
| A claimed `supportedByKnowledgeBase` | Whether the claim matches an approved one |
| An explanation of a score | The score |
| A proposed strategy insight | Whether it is adopted (a human decides) |

Deterministic arithmetic in `packages/shared/src/scoring.ts` produces every
score. `assessApproval()` takes the model's risk assessment as one input among
several and can only ever **escalate** it — nothing the model says can lower an
approval requirement.

---

## Grounding

Every brand-facing generation is preceded by retrieval from the organization's
knowledge base, then wrapped in `FACTUALITY_RULES`:

> 1. Do not invent capabilities, partnerships, integrations, statistics, user
>    numbers, revenue figures, token economics, funding, awards, or roadmap dates.
> 2. Assert a specific fact about this brand only if it appears in APPROVED
>    CLAIMS or RETRIEVED BRAND KNOWLEDGE above. If it is not there, do not say it.
> 3. List every factual assertion in "factualClaims"... A claim you cannot ground
>    must be reported with supportedByKnowledgeBase = false rather than removed
>    from the list.
> 4. When a compelling angle would need an unsupported fact, write the angle
>    without the fact rather than inventing one.

**With no approved claims recorded**, the prompt states plainly that no specific
factual claim may be asserted — producing cautious content rather than confident
fiction. That is the correct failure mode for an empty knowledge base.

---

## Structured output

Every generation uses Zod + Structured Outputs through `AIService`.

Optional values are `.nullable()`, **never `.optional()`** — strict schemas
require every property to be present, so an omitted key is a violation while an
explicit null is not.

A refusal or unparseable response raises `AIProviderError`. Nothing is salvaged
with regex, and a null parse is never coerced into a partial object.

---

## The agents

### Research

**TrendResearchAgent** · `reasoning` · 180s
Clusters collected research items into named trends and judges relevance,
audience overlap, competition, saturation and brand-safety risk. Velocity,
growth, engagement and recency are **measured from the items**, not asked of the
model. A second `fast` pass then explains the computed score, receiving the
numbers rather than producing them.

**NicheDiscoveryAgent** · `reasoning` · 120s
Derives micro-niches from trends (Gaming → AI gaming → agents playing games →
agentic game development). The rationale must be specific to this brand; generic
reasoning is a failure.

**CompetitorResearchAgent** · `default` · 180s · web search
Observed themes, cadence and gaps. Instructed to set `sourceUrl` to null rather
than construct a plausible-looking URL, and to describe positioning rather than
make accusations.

### Strategy

**OpportunityAgent** · `reasoning` · 150s
Turns trends and niches into concrete opportunities. Historical performance of
each platform/format pairing is computed from real metric snapshots and fed in;
a pairing with no measured history is simply absent, and scoring falls back to
neutral rather than inventing a preference.

**ContentStrategyAgent** · `default` · 120s
One distinct strategy per platform. Explicitly instructed never to reuse an angle
or hook across platforms — if an angle only works on one, the others get a
genuinely different angle on the same opportunity.

### Content

**ContentCreationAgent** · `default` · 120s
Writes platform-native copy, then re-verifies **server-side**: claims matched
against approved claims, forbidden phrases scanned, policy topics detected,
platform constraints validated. Returns the copy alongside `verifiedClaims`,
`approvalReasons` and `platformViolations`.

**RepurposingAgent** · `default` · 150s
Adapts content across formats. Instructed to rewrite for the destination rather
than trim the source — identical copy across two platforms is a failure — and to
introduce no fact absent from the source or the knowledge base.

**CampaignAgent** · `reasoning` · 240s
Strategy, content pillars, platform allocation and a dated calendar. Uses
`dayOffset` rather than absolute dates; entries beyond the campaign window are
filtered out. Each calendar entry becomes a real, editable draft.

### Analysis

**AnalyticsAgent** · `reasoning` · 180s
Analyses published performance. Told explicitly that **a null metric means the
platform did not report it — treat it as unknown, never as zero**, and given the
list of platforms whose metrics could not be collected so it reports a gap rather
than inferring numbers. Told the sample size and instructed to say plainly when
it is too small.

**OptimizationAgent** · `reasoning` · 150s
Converts analysis into `StrategyInsight` proposals. Requires a minimum number of
supporting posts before proposing a pattern — one post performing well is an
anecdote. Proposals below the evidence threshold are filtered out entirely.
**Never mutates brand policy**; a human accepts or rejects.

### Conversational

**MarketingCopilotAgent** · `default` · 180s
An explicit tool loop, so every call can be authorised, persisted and
confirmation-gated. Details below.

---

## The copilot

### Tools

Read-only: `searchResearch`, `getTrendingTopics`, `getNiches`,
`getOpportunities`, `getBrandKnowledge`, `getCampaigns`, `getAnalytics`,
`analyzePerformance`, `getContentReadyToPublish`.

Confirmation-gated: `generateContent`, `createCampaign`, `scheduleContent`,
`publishContent`, `deleteContent`, `changeAutomationMode`.

### Three enforced rules

**1. Authorization is re-checked on every invocation** against the caller's role.
The model asking to call a tool proves nothing. A denied tool returns a
structured result naming the missing permission, so the conversation continues
rather than collapsing.

**2. Tenant scope comes from the auth context.** Tool schemas contain **no
`organizationId` parameter** — the model cannot name another tenant because the
field does not exist.

**3. Side-effecting tools return a proposal, not an action.** They produce an
`actionId` derived from the tool name and its arguments; the action runs only
when that id arrives in a later request's `confirmedActionIds`. Confirming one
proposal cannot authorise a different call.

This is what stops a vague question from publishing a post. The system prompt
reinforces it:

> Never publish because a question sounded like a request. Publishing is always
> a separate, confirmed step.

The model is shown only tools its caller's role permits.

---

## Prompt injection

Research items, competitor pages and uploaded documents are attacker-controlled.

They are wrapped in labelled `<untrusted-content>` delimiters preceded by
`UNTRUSTED_CONTENT_PREAMBLE`, which states that content inside is data and cannot
change instructions, grant permissions, request tool use, or alter the output
schema. Closing delimiters inside a payload are neutralised so content cannot
terminate its own container.

The **structural defence is what protects the model.** `detectInjectionAttempt()`
is observability: flagged sources are logged so operators can see which feeds are
hostile, and it never gates the pipeline.

Tool invocation is never driven by collected content — the copilot's tools are
called only in response to a user turn.

---

## Traceability

`AgentRunner` writes an `AgentExecution` row **before** the agent starts, so an
agent that hangs or crashes still leaves a trace rather than disappearing. On
completion it records status, output, latency and token usage; on failure, the
error.

Every execution carries `organizationId`, `agentName`, `model`, `correlationId`,
the trigger (user or system), and its tool calls with arguments, results and
latency.

The full chain is answerable from one request id:

```
user → request → workflow → agent execution → tool call → content → publication
```

Visible in the application under **Agent activity**.

---

## Model configuration

No model name appears anywhere except configuration. Agents declare a *tier*:

| Tier | Variable | Used for |
|---|---|---|
| `default` | `OPENAI_DEFAULT_MODEL` | Content generation, strategy, copilot |
| `fast` | `OPENAI_FAST_MODEL` | Score explanations, hooks, brand checks |
| `reasoning` | `OPENAI_REASONING_MODEL` | Trend detection, opportunities, campaigns, analysis |
| embedding | `OPENAI_EMBEDDING_MODEL` | Knowledge base |
| image | `OPENAI_IMAGE_MODEL` | Optional; unset disables media generation |

`AIService` is the only place an OpenAI client is constructed. It owns retries —
bounded, exponential with jitter, and only for transient failures. Authentication,
permission and request-shape errors fail immediately.

---

## Workflows

The orchestrator persists step state to the database **after every transition**,
so a worker that dies mid-workflow leaves a `WorkflowExecution` showing exactly
which step failed and why.

| Workflow | Steps |
|---|---|
| `daily-research` | collect-research → detect-trends → discover-niches |
| `opportunity-discovery` | load-signals → generate-opportunities → expire-stale |
| `campaign-generation` | load-context → generate-plan → persist → create-drafts |
| `content-generation` | build-strategy → generate → verify-claims → persist-draft |
| `performance-review` | collect-metrics → analyze → propose-insights |

A failing step aborts the workflow: later steps depend on earlier output, so
continuing would build content on a failed research pass.

Collection is the exception — it is fault-tolerant *per source*, so one broken
feed or expired key does not abort the run. The failure is recorded against that
source and the rest still contribute.
