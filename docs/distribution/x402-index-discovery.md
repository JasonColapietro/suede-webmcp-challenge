# Submission Draft — x402-index Discovery Index

**Repo:** https://github.com/x402-index/x402-discovery-index  
**Mechanic:** Open a GitHub issue in that repo  
**Cost:** Free  

Recheck the destination's current submission rules before using this draft.

---

## Issue title

```
Add Suede Agent Studio — visual agent flows + @suedeai/agents SDK, x402 v2 on Base
```

## Issue body

````markdown
## Service: Suede Agent Studio

**Site:** https://agents.suedeai.ai
**x402 v2 discovery:** https://agents.suedeai.ai/.well-known/x402
**Live catalog:** https://agents.suedeai.ai/api/catalog
**OpenAPI:** https://agents.suedeai.ai/openapi.json
**SDK docs:** https://agents.suedeai.ai/docs#sdk

### What it does

Suede Agent Studio is a visual agent-flow builder and installable TypeScript
SDK. Creators can build on the canvas, publish with `@suedeai/agents`, or link
an idempotent relay-v2 service. Each published agent has a public run endpoint,
x402 discovery document, AgentCard, and A2A 1.0 HTTP+JSON interface.

Priced Live calls can accept x402 v2 payments when both the service and the
platform settlement path are enabled. Explicit dry runs remain non-settling.
The live catalog is authoritative for current agents, prices, payout addresses,
and `acceptsPayment` state.

### Payment protocol

- x402 version: 2
- scheme: `exact`
- network: `eip155:8453` (Base)
- asset: Base USDC, published in each current discovery document
- challenge header: `PAYMENT-REQUIRED`
- payment retry header: `PAYMENT-SIGNATURE`

### Discovery flow

```bash
# Current agents and whether each one accepts payment
curl https://agents.suedeai.ai/api/catalog

# Service-level x402 v2 index
curl https://agents.suedeai.ai/.well-known/x402

# Replace <slug> with a current catalog entry
curl https://agents.suedeai.ai/api/agents/<slug>/.well-known/x402
curl https://agents.suedeai.ai/api/agents/<slug>/.well-known/agent-card.json
curl https://agents.suedeai.ai/api/agents/<slug>/a2a
```

A2A is the agent discovery and invocation interface. x402 is the caller-payment
settlement rail. Stripe is used separately to fund builder gateway credit.

### Maintainer

GitHub: @JasonColapietro
````

---

## Verification before submission

Do not add a static agent count or example slug to the issue. Immediately before
submission, confirm that the catalog and root x402 document return `200`, then
choose a current `acceptsPayment: true` entry only if a maintainer explicitly
requests a concrete paid-call example.
