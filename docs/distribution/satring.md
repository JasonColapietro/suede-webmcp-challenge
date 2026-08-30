# Submission Draft — Satring

**Site:** https://satring.com
**Repo:** https://github.com/toadlyBroodle/satring
**Mechanic:** Paid API submission — `POST https://satring.com/api/v1/services`
**Payment gate:** Anti-spam fee paid in USDC via x402 (or L402/MPP Lightning)
**No PR required** — submission is API-only, auto-listed after payment

---

## Overview

Satring is a health-monitored, curated directory for paid APIs accepting L402,
MPP, or x402. You submit via their API, paying a small listing fee in USDC.
After verification the service appears in the public directory for agent
discovery.

**Historical draft:** do not submit the payload below as current truth. Generate
a fresh payload from the live catalog/discovery console so state, price, payTo,
and service availability match the selected payment-enabled endpoint.

---

## Payment details (confirmed 2026-06-11 via live 402 probe)

| Field | Value |
|---|---|
| Fee | 0.50 USDC (500,000 raw — 6 decimal USDC on Base) |
| Also accepts | 1,000 sats Lightning (L402 or MPP) |
| Network | Base `eip155:8453` |
| Asset | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC) |
| payTo | `0x2985E0Bf522596254b2932F8E95fdE69F90C14f2` |
| x402 Version | 2 |
| maxTimeoutSeconds | 300 |
| Payment method header | `PAYMENT-SIGNATURE: <base64-signed-payload>` |

x402 docs: https://satring.com/.well-known/x402
L402 docs: https://satring.com/.well-known/l402
MPP docs: https://satring.com/.well-known/mpp

---

## Categories (confirmed live from GET /api/v1/categories 2026-06-11)

| ID | Slug | Description |
|---|---|---|
| 1 | ai-ml | Machine learning and AI inference APIs |
| 2 | data | Data feeds, aggregation, and analytics |
| 3 | finance | Financial data, trading, and payment APIs |
| 4 | identity | KYC, authentication, and verification |
| 5 | media | Image, video, and audio processing |
| 6 | social | Social networks, communications, and notification APIs |
| 7 | search | Web search, indexing, and discovery |
| 8 | storage | File storage and content delivery |
| 9 | tools | Developer tools, utilities, and infrastructure |

**Best-fit for Suede Agent Studio:** `1` (ai-ml) and `9` (tools)

---

## Submission payload

Submit this JSON to `POST https://satring.com/api/v1/services` with a valid
x402 payment header (pay the 402 challenge first, then retry with proof):

```json
{
  "name": "Suede Agent Studio",
  "url": "https://agents.suedeai.ai",
  "description": "Visual agent-flow builder + TypeScript SDK (@suedeai/agents) where creators publish machine-callable services. Each service advertises preview, payment-enabled, or unavailable; payment-enabled calls use x402 v2 and exact USDC on Base. Catalog at /api/catalog; each agent exposes /.well-known/x402, an AgentCard, and an A2A interface.",
  "pricing": {
    "amount": "0.10",
    "currency": "USDC",
    "model": "per-request"
  },
  "protocols": ["x402"],
  "categories": [1, 9],
  "discovery_url": "https://agents.suedeai.ai/.well-known/x402",
  "catalog_url": "https://agents.suedeai.ai/api/catalog"
}
```

---

## Submission flow

### Option A: x402 (USDC on Base) — recommended

```bash
# Step 1 — probe the submission endpoint to get a fresh 402 challenge
curl -i -X POST https://satring.com/api/v1/services \
  -H "Content-Type: application/json" \
  -d '{"name":"Suede Agent Studio","url":"https://agents.suedeai.ai"}'
# → HTTP 402
# Note the `payment-required` header (base64) and the x402Version/payTo/amount

# Step 2 — send 500000 USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
# to 0x2985E0Bf522596254b2932F8E95fdE69F90C14f2 on Base (eip155:8453)
# Use coinbase/x402 TypeScript SDK or @payai/x402-client to build the signed payload.
# The SDK returns a base64-encoded payment proof string.

# Step 3 — retry with payment proof header
curl -X POST https://satring.com/api/v1/services \
  -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: <base64-signed-payment-payload>" \
  -d '{
    "name": "Suede Agent Studio",
    "url": "https://agents.suedeai.ai",
    "description": "Visual agent-flow builder where creators publish machine-callable services with explicit preview, payment-enabled, or unavailable state. Payment-enabled calls use x402 v2 and exact USDC on Base. Machine-readable catalog at /api/catalog; each agent exposes /.well-known/x402, an AgentCard, and an A2A interface.",
    "pricing": {"amount": "0.10", "currency": "USDC", "model": "per-request"},
    "protocols": ["x402"],
    "categories": [1, 9],
    "discovery_url": "https://agents.suedeai.ai/.well-known/x402",
    "catalog_url": "https://agents.suedeai.ai/api/catalog"
  }'
```

### Option B: Lightning (L402)

```bash
# From the 402 response www-authenticate header:
# 1. Extract macaroon and invoice fields
# 2. Pay the BOLT11 invoice (1,000 sats)
# 3. Retry with: Authorization: L402 <macaroon>:<preimage>
```

### Option C: Lightning (MPP)

```bash
# 1. Extract Payment id from www-authenticate
# 2. Pay the BOLT11 invoice in the challenge `request` field
# 3. Build credential with paymentHash + preimage
# 4. Retry with: Authorization: Payment <base64url-credential>
```

---

## Notes

- The 402 challenge expires — the `payment-required` payload has a 5-minute
  `maxTimeoutSeconds`. Probe and pay in the same session.
- Satring auto-health-monitors listed services — `/.well-known/x402` at
  `agents.suedeai.ai` must stay live and return valid JSON or the listing
  may be flagged as unhealthy.
- Payment is one-time; no subscription.
