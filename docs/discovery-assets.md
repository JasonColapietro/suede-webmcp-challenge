# Suede Agent Studio Discovery Assets

Source of truth for Agent Studio directory submissions. Current runtime data
always comes from the catalog and discovery documents below; do not copy agent
counts, slugs, prices, payout addresses, or settlement readiness into a listing.

---

## Short description (150 chars)

Build and publish AI agent workflows with machine-readable discovery and optional x402 v2 settlement in USDC on Base.

## Long description (400 chars)

Suede Agent Studio is a visual agent builder and TypeScript SDK. Published
workflows get public run, x402 discovery, AgentCard, and A2A 1.0 HTTP+JSON
interfaces. Priced Live calls can settle USDC on Base through x402 v2 when the
service and platform are payment-enabled; otherwise callers can use the
documented dry-run path.

## Category tags

x402, ai-agents, agent-builder, base, usdc, a2a, typescript-sdk, no-code

---

## Canonical URLs

- Site: https://agents.suedeai.ai
- Docs: https://agents.suedeai.ai/docs
- Live catalog: https://agents.suedeai.ai/api/catalog
- Curated services: https://agents.suedeai.ai/api/services
- x402 v2 discovery: https://agents.suedeai.ai/.well-known/x402
- Root AgentCard: https://agents.suedeai.ai/.well-known/agent-card.json
- OpenAPI 3.1: https://agents.suedeai.ai/openapi.json
- GitHub: https://github.com/JasonColapietro/suede-agent-studio

Per-agent URLs must be read from the catalog. The canonical patterns are:

- `https://agents.suedeai.ai/api/agents/<slug>/.well-known/x402`
- `https://agents.suedeai.ai/api/agents/<slug>/.well-known/agent-card.json`
- `https://agents.suedeai.ai/api/agents/<slug>/a2a`
- `https://agents.suedeai.ai/api/agents/<slug>/run`

---

## Current protocol boundary

- Caller settlement: x402 v2, scheme `exact`, USDC on Base
  (`eip155:8453`).
- Challenge: read the JSON response or decode the `PAYMENT-REQUIRED` header.
- Retry proof: `PAYMENT-SIGNATURE`.
- A2A: discovery and HTTP+JSON invocation interface, not a settlement rail.
- Stripe: card funding for builder gateway credit, not caller settlement for a
  published agent run.
- AP2: experimental merchant authorization before x402 settlement, advertised
  only when the service and runtime readiness gates pass.

Review snapshot on 2026-08-14: the live catalog contained 31 published entries,
3 of which advertised real payment acceptance. This is verification history,
not reusable listing copy; read the catalog again before any submission.

---

## Directory descriptor

Use discovery URLs instead of a fixed price or payout address:

```json
{
  "name": "Suede Agent Studio",
  "description": "Visual agent flows and a TypeScript SDK with optional x402 v2 settlement in USDC on Base.",
  "url": "https://agents.suedeai.ai",
  "catalog": "https://agents.suedeai.ai/api/catalog",
  "x402Discovery": "https://agents.suedeai.ai/.well-known/x402",
  "agentCard": "https://agents.suedeai.ai/.well-known/agent-card.json",
  "network": "eip155:8453",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "scheme": "exact",
  "category": "ai-tools"
}
```

---

## Submission verification

Before drafting or updating an external listing:

1. Read `GET https://agents.suedeai.ai/api/catalog` for current entries and
   `acceptsPayment` state.
2. Read `GET https://agents.suedeai.ai/.well-known/x402` for current x402 v2
   terms and facilitator metadata.
3. Choose a current payment-enabled agent from the catalog only if the
   directory requires a concrete example.
4. Read that agent's discovery document; never invent a price, `payTo`, ID, or
   slug.
5. Describe A2A as an interface and Stripe as builder-credit funding.
6. Stop at a draft when the destination needs login, payment, or human review.
