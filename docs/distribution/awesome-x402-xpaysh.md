# Submission Draft — awesome-x402 (xpaysh/awesome-x402)

**Repo:** https://github.com/xpaysh/awesome-x402  
**File to edit:** `README.md`  
**Section:** Confirm the destination's current implementation section
**Mechanic:** GitHub pull request, one resource per PR  

---

## PR title

```
Add Suede Agent Studio — visual agent flows + @suedeai/agents SDK with x402 v2
```

## PR body

> **What's being added**
>
> Suede Agent Studio — https://agents.suedeai.ai
>
> A visual agent-flow builder and TypeScript SDK. Published agents receive a
> run endpoint, x402 v2 discovery, AgentCard, and A2A 1.0 HTTP+JSON interface.
> Priced Live calls can settle exact USDC on Base (`eip155:8453`) when the
> service's current catalog entry reports `acceptsPayment: true`; dry runs and
> payment-disabled services do not claim settlement.
>
> **Machine discovery**
>
> - https://agents.suedeai.ai/.well-known/x402
> - https://agents.suedeai.ai/api/catalog
> - https://agents.suedeai.ai/openapi.json

---

## Exact line to add

```markdown
- **[Suede Agent Studio](https://agents.suedeai.ai)** - Visual agent-flow builder and TypeScript SDK with x402 v2 settlement for payment-enabled Live calls (exact USDC on Base). Machine-readable [discovery](https://agents.suedeai.ai/.well-known/x402) and [catalog](https://agents.suedeai.ai/api/catalog).
```

---

## Verification

```bash
curl https://agents.suedeai.ai/api/catalog
curl https://agents.suedeai.ai/.well-known/x402
curl https://agents.suedeai.ai/api/agents/<current-payment-enabled-slug>/.well-known/x402
```

Confirm x402 v2 fields (`eip155:8453`, atomic `amount`, current `asset` and
`payTo`) immediately before opening the PR. A payment-enabled challenge is
returned in `PAYMENT-REQUIRED`; the signed retry uses `PAYMENT-SIGNATURE`.
Avoid volatile counts, example agents, and payout addresses.
