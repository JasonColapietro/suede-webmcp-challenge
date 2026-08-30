# Submission Draft — pay.sh

**Site:** https://pay.sh  
**Mechanic:** Confirm the current provider schema and listing process before
submission.

The previous static provider example modeled one historical agent with x402 v1
fields. Agent Studio now publishes dynamic per-agent x402 v2 requirements, so a
fixed price, payout address, agent ID, or legacy network value is not a safe
provider specification.

---

## Current Agent Studio source

- Site: https://agents.suedeai.ai
- Live catalog: https://agents.suedeai.ai/api/catalog
- x402 v2 discovery: https://agents.suedeai.ai/.well-known/x402
- OpenAPI: https://agents.suedeai.ai/openapi.json
- Per-agent x402: `https://agents.suedeai.ai/api/agents/<slug>/.well-known/x402`
- Per-agent AgentCard:
  `https://agents.suedeai.ai/api/agents/<slug>/.well-known/agent-card.json`
- A2A 1.0 interface: `https://agents.suedeai.ai/api/agents/<slug>/a2a`

Agent Studio's caller-payment profile is x402 v2, scheme `exact`, Base network
`eip155:8453`, and USDC. Each payment-enabled agent's discovery document owns
its atomic `amount`, asset, `payTo`, and timeout. Do not duplicate those fields
in a static directory file unless pay.sh can refresh them from discovery.

---

## Suggested provider metadata

Map these values into the destination's current schema after validating it:

```yaml
name: suede-agent-studio
title: 'Suede Agent Studio'
description: 'Visual agent flows and a TypeScript SDK with x402 v2 settlement for payment-enabled Live calls.'
category: ai_ml
url: https://agents.suedeai.ai
catalog: https://agents.suedeai.ai/api/catalog
x402_discovery: https://agents.suedeai.ai/.well-known/x402
openapi: https://agents.suedeai.ai/openapi.json
network: eip155:8453
asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
scheme: exact
```

Do not submit this YAML until the live pay.sh schema confirms these keys. If the
schema requires fixed endpoint pricing, submit only a current
`acceptsPayment: true` catalog entry and derive every field from its discovery
document immediately before submission.

---

## Verification flow

```bash
# Current agents, endpoint URLs, prices, and payment readiness
curl https://agents.suedeai.ai/api/catalog

# Current service-level x402 v2 index
curl https://agents.suedeai.ai/.well-known/x402

# Replace <slug> with a current payment-enabled catalog entry
curl https://agents.suedeai.ai/api/agents/<slug>/.well-known/x402
```

For a real payment-enabled run, an unpaid request returns a
`PAYMENT-REQUIRED` challenge. The caller signs the exact advertised requirement
and retries using `PAYMENT-SIGNATURE`. A2A remains the invocation interface;
Stripe separately funds builder gateway credit and is not the caller-settlement
rail.
