# Submission Draft — Agentic.Market

**Site:** https://agentic.market  
**Mechanic:** Confirm the current listing process, then contact the maintainers
if human review is still required.

This is a draft only. Recheck the destination, catalog, and payment readiness
before sending it.

---

## Outreach message

**Subject / issue title:**

```
Add Suede Agent Studio — visual agent-flow builder + SDK with x402 v2
```

**Body:**

> Hi — I'd like to list Suede Agent Studio in the Agentic.Market catalog.
>
> **Service:** Suede Agent Studio<br>
> **URL:** https://agents.suedeai.ai<br>
> **Category:** AI / Agent tools<br>
> **Caller-payment protocol:** x402 v2, exact USDC on Base (`eip155:8453`)
>
> **What it does:**  
> Suede Agent Studio is a visual agent-flow builder and TypeScript SDK. Build
> on the canvas, publish with `@suedeai/agents`, or link an idempotent relay-v2
> service. Published agents expose run, x402 discovery, AgentCard, and A2A 1.0
> HTTP+JSON interfaces.
>
> Priced Live calls accept and settle x402 only when the service and platform
> payment path are enabled. The live catalog reports the current
> `acceptsPayment` state; explicit dry runs do not settle.
>
> **Discovery:**  
> - x402 index: https://agents.suedeai.ai/.well-known/x402
> - Catalog: https://agents.suedeai.ai/api/catalog
> - Root AgentCard: https://agents.suedeai.ai/.well-known/agent-card.json
> - OpenAPI: https://agents.suedeai.ai/openapi.json
> - SDK docs: https://agents.suedeai.ai/docs#sdk
>
> A2A is the discovery and invocation interface. x402 is the settlement rail
> for caller payments. Stripe separately funds builder gateway credit.
>
> GitHub: @JasonColapietro

---

## Verification commands

```bash
# Read current agents, prices, URLs, and payment readiness.
curl https://agents.suedeai.ai/api/catalog

# Read current x402 v2 requirements and facilitators.
curl https://agents.suedeai.ai/.well-known/x402

# Replace <slug> only with a current payment-enabled catalog entry.
curl https://agents.suedeai.ai/api/agents/<slug>/.well-known/x402
```

A payment-enabled call without proof returns a `PAYMENT-REQUIRED` challenge.
The caller signs the exact advertised v2 requirement and retries with
`PAYMENT-SIGNATURE`. Never paste a historical agent ID, price, payout address,
or count into the submission.
