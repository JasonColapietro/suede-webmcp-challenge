# Suede Agent Studio — Distribution Listings

Canonical URL: https://agents.suedeai.ai
Discovery: https://agents.suedeai.ai/.well-known/x402
Catalog: https://agents.suedeai.ai/api/catalog
Contact/maintainer: GitHub @JasonColapietro

## What we're listing

Suede Agent Studio publishes user-built visual agent flows as machine-callable
services. Each listing explicitly reports `preview`, `payment-enabled`, or
`unavailable`; payment-enabled calls use x402 v2 and exact USDC on Base.
Machine-readable discovery lives at `/.well-known/x402`;
each agent exposes its own `/.well-known/x402`, `/.well-known/agent-card`, and
`/a2a` endpoint. The public catalog returns live agent metadata as JSON.

## The submission assets are now generated at runtime — this folder is reference only

The per-venue drafts in this directory are **historical**, and the old example
agents / zero-address `payTo` in them are exactly the drift a generated system
fixes. The live source of truth is code, not markdown:

- **Venue registry:** `src/lib/distribution/venues.ts` — every venue, its real
  mechanism, and an honest status line.
- **Generated payloads:** `src/lib/distribution/payloads.ts` — every submission
  asset (x402Scout register body, Satring JSON, awesome-list line, discovery-index
  issue, pay.sh YAML, Agentic.Market outreach) is built from live `buildCatalog()`
  data, so slug, price, and `payTo` are always the real current values.
- **Readiness + submission:** the per-agent Discovery console (portfolio → an
  agent → "Get discovered") checks readiness and drives submission through
  `GET`/`POST /api/agents/[agent]/discovery`.

## What the console automates vs. what it doesn't

| Mechanism | Venues | What happens |
|---|---|---|
| **One click (push-free)** | x402Scout / Bazaar discovery API | Server POSTs your live listing to the free `/register` endpoint; the result is recorded. |
| **Opens a GitHub PR / issue (push-github)** | awesome-x402 (xpaysh), awesome-x402 (x402-index), x402-index Discovery Index | Opens a real PR/issue **when `GITHUB_DISTRIBUTION_TOKEN` is set**. Absent → an honest 501; use the generated draft manually. |
| **Automatic** | Coinbase Bazaar, x402search.xyz | Nothing to submit. Bazaar can index a payment-enabled service after a settled call; x402search crawls indexed listings. Publication alone is not settlement readiness. |
| **Paid** | Satring | 0.50 USDC listing fee. Spending is never automated — the console shows the generated payload and an honest "requires payment approval" status. |
| **Manual** | pay.sh, Agentic.Market | No public API. The console generates the provider YAML / outreach; a human sends it. |

## Open item

GitHub push automation needs a `GITHUB_DISTRIBUTION_TOKEN` with access to open a
PR/issue on the target repos (a fork-first flow is the follow-up for repos the
token can't push to directly). Until it's provisioned, the push-github venues
return a 501 and the console falls back to the copyable draft.
