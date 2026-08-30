# Submission Draft — awesome-x402 (x402-index org)

**Repo:** https://github.com/x402-index/awesome-x402  
**File to edit:** `README.md`  
**Section:** `Production Implementations` or the destination's current
equivalent
**Mechanic:** GitHub pull request  

---

## PR title

```
Add Suede Agent Studio — visual agent flows + @suedeai/agents SDK with x402 v2
```

## PR body

> Adding Suede Agent Studio as an x402 implementation.
>
> **Service:** https://agents.suedeai.ai<br>
> **x402 v2 discovery:** https://agents.suedeai.ai/.well-known/x402<br>
> **Live catalog:** https://agents.suedeai.ai/api/catalog
>
> Suede Agent Studio combines a visual canvas, TypeScript SDK, and idempotent
> relay-v2 mode. Published agents expose per-agent x402 discovery plus A2A 1.0
> HTTP+JSON and AgentCard interfaces. Priced Live calls settle exact USDC on
> Base (`eip155:8453`) only when their current catalog entry advertises
> `acceptsPayment: true`; explicit dry runs remain non-settling.

---

## Exact line to add

```markdown
- [Suede Agent Studio](https://agents.suedeai.ai) - Visual agent-flow builder and TypeScript SDK publishing payment-enabled Live calls over x402 v2 (exact USDC on Base). [Discovery](https://agents.suedeai.ai/.well-known/x402) · [Catalog](https://agents.suedeai.ai/api/catalog) · [GitHub](https://github.com/JasonColapietro/suede-agent-studio)
```

---

## Verification

```bash
curl https://agents.suedeai.ai/api/catalog
curl https://agents.suedeai.ai/.well-known/x402
curl https://agents.suedeai.ai/api/agents/<current-payment-enabled-slug>/.well-known/x402
```

The last document must advertise `x402Version: 2`, scheme `exact`, network
`eip155:8453`, an atomic `amount`, and the current asset and `payTo`. An unpaid
payment-enabled call returns `PAYMENT-REQUIRED`; retry with
`PAYMENT-SIGNATURE`. Do not include a fixed count, price, slug, or payout
address in the PR.
