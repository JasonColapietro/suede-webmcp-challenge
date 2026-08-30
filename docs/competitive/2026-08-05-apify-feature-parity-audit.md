# Apify feature-parity audit — Suede Agent Studio

**Date:** 2026-08-05
**Scope:** Apify (apify.com), the Actors/agent marketplace. Not appify.com (enterprise
no-code app builder), which is a different lane and was ruled out at intake.
**Method:** Apify's documented platform surface (docs.apify.com/platform, monetization
docs) mapped against this repo's shipped routes, node catalog, SDK, and libs.
**Status:** audit only. No code changed.

## Why Apify is the right comparison

Apify is the only mature product with the same core loop Agent Studio is betting on:
a creator builds a unit of automation, publishes it to a public store, and gets paid
per call by strangers. Their north-star loop is our north-star metric. Everything below
is judged against *that* loop, not against Apify's scraping business.

## The scoreboard

| Apify area | Agent Studio today | Verdict |
| --- | --- | --- |
| Actors (serverless programs) | 42-node visual catalog + `@suedeai/agents` SDK for code agents | **Parity, different bet** |
| Store / public marketplace | `/agents` directory, `/api/catalog`, `.well-known` discovery | **Gap — build** |
| Storage (dataset, KV, request queue) | Runs + run steps persisted; SDK `memory`; no addressable dataset | **Gap — build (scoped)** |
| Proxy (residential/datacenter rotation) | None; `web.fetchUrl` is a plain fetch | **Skip** |
| REST API | Large `v2`/`v3` surface, workspace keys | **Parity** |
| SDK | `@suedeai/agents` (TypeScript) | **Parity; Python = skip** |
| CLI | `suede` CLI in agent-kit: init/login/push/pull/versions/dev/whoami | **Parity** |
| Scheduling | `schedule` node + `/api/cron/tick` | **Parity** |
| Integrations (100+) | `v2/connectors` + arbitrary OpenAPI import + `/from-website` | **Ahead** |
| Monetization | Flat per-call USDC via x402 + payout routing | **Gap — build** |
| Console (runs, logs, monitoring) | `/runs`, `/runs/[id]`, v3 SSE events, run retry | **Parity** |
| Standby mode (warm HTTP) | Every published agent *is* an always-on HTTP endpoint | **Parity by architecture** |
| Tasks (saved input presets) | Templates are blueprints, not per-agent saved runs | **Gap — build (cheap)** |
| MCP server | None. "MCP" appears only in marketing copy | **Gap — build (highest leverage)** |
| Academy / docs | `/docs/*` shell incl. derived 42-node catalog | **Parity** |
| Teams / orgs / RBAC | Single-owner workspaces | **Gap — defer** |

## The five gaps worth closing, in order

### 1. MCP server — expose every published agent as an MCP tool
**Highest leverage. Build first.**
Apify ships an MCP server so any MCP client (Claude, Cursor, an agent framework) can
discover and call Actors as tools. Agent Studio has zero MCP implementation — the only
matches in the repo are two marketing pages that *mention* MCP.

This maps directly onto the north-star metric (third-party calls to user-published
agents). We already have the hard parts: a public catalog, per-agent JSON schemas from
the input node, an always-on HTTP endpoint per agent, and x402 pricing metadata. An MCP
server over that is mostly a projection of `buildCatalog()` plus a tool-call bridge into
`/api/agents/[agent]/run`.

Open question that needs a decision, not a guess: how a paid (x402) tool call behaves
inside an MCP session. Options are pre-funded workspace credit, a 402 the client is
expected to handle, or free-tier-then-charge.

### 2. Pay-per-event pricing
Apify supports pay-per-event: the Actor's own code charges for defined events, so price
tracks results delivered rather than calls attempted. Agent Studio only supports one
flat price per call. That mis-prices every agent whose output varies — a lead scorer
returning 3 rows and one returning 300 cost the buyer the same.

Ledger infrastructure is already there (per-node USDC cost ledger in the engine,
`createUsage`, settlement records). The gap is a pricing model that reads it, plus a
way for a flow to emit a billable event.

### 3. Datasets — addressable, accumulating agent output
Runs and run steps are persisted, but there's no user- or buyer-addressable store where
an agent's output piles up across runs and can be paged, filtered, or exported. This is
load-bearing for the product feeling in `AI_HANDOFF.md`: a scheduled agent running for
a month should have produced *something you can go look at*.

Scope it narrowly — one append-only dataset per agent, JSON rows, paginated read API,
CSV/JSON export. Do not rebuild Apify's three storage primitives; the request queue is
scraping-specific and irrelevant here.

### 4. Directory hardening — the Store gap
`/agents` and `/api/catalog` cover listing and machine discovery, but the directory has
no ratings, no reviews, no category facets, no popularity or usage counts, no "run this
now" affordance from the listing. Apify's Store converts because of exactly that social
proof and browsability.

Cheapest high-value slice: derived usage counts (we already have `getRunOutcomeStats`
and settlement records), category facets from the node catalog, and sort-by-activity.
Ratings/reviews bring a moderation surface — we have `moderation/reports`, so it's not
free, but it's not greenfield either.

### 5. Tasks — saved input presets per agent
Apify Tasks are a saved, named input configuration for an Actor you can re-run or
schedule. Agent Studio's templates are blueprints for *building* a flow, which is a
different thing. Small feature, real UX value, and it is the natural object to attach a
schedule to.

## Deliberate skips, with reasons

- **Proxy / IP rotation.** Apify's core business, built over a decade. Enormous cost and
  abuse surface (we would be selling anonymized scraping). Not our lane.
- **Python SDK.** Our buyer is another agent calling an HTTP/x402 endpoint, which is
  language-agnostic. The TS SDK covers creators who write code. Revisit only if creator
  demand shows up.
- **Arbitrary container/Actor execution.** Apify runs any Docker image in any language.
  Matching that means becoming a compute platform. The typed 42-node catalog plus the
  SDK is the deliberate opposite bet and is the thing that makes flows inspectable,
  priceable per node, and safe to run for strangers.
- **Teams / orgs / RBAC.** Real gap, but it serves enterprise buyers, not the north-star
  loop. Defer until a customer asks.

## Where we are already ahead

- **Settlement.** Apify pays creators monthly through their own billing rails. Every
  Agent Studio call settles to a creator-controlled wallet in USDC on Base. No payout
  cycle, no platform-held float.
- **Integration breadth per unit of work.** Apify's 100+ integrations are a
  hand-maintained list. Arbitrary OpenAPI import plus `/from-website` means the
  integration surface is not capped by our build throughput.
- **Visual authoring.** Apify Actors are code. The canvas is the product for the
  non-engineer half of the market Apify does not serve.

## What this audit did not verify

- Apify's live Store metrics, actual revenue-share percentage, and rental-model
  mechanics — their docs page on monetization does not state the share, so no number is
  claimed here.
- Whether any of the five gaps above are already partially covered by unmerged work on
  other branches. Checked `main` only.
