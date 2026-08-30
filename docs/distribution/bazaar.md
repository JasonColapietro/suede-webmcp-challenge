# CDP Bazaar — Notes

**Site:** https://www.coinbase.com/developer-platform  
**Auto-listing:** Yes — Bazaar listings are generated automatically from CDP
facilitator settlement data. No manual submission is possible or needed.

---

## How auto-listing works

CDP Bazaar aggregates endpoints that have been verified through the Coinbase
x402 facilitator network. When a real USDC settlement passes through a CDP
facilitator node, the endpoint metadata (discovery URL, price, asset, payTo)
is indexed automatically.

**Implication for Suede Agent Studio:** once live settlement traffic flows
through the CDP facilitator at `facilitator.payai.network` (or directly via
the Coinbase x402 SDK), the studio's agents will appear in Bazaar without any
manual action from Jason.

---

## Prerequisites for auto-listing

1. `X402_SKIP_SETTLEMENT=false` is already set in prod (shipped in the revenue
   pass).
2. Per-agent `settlement_live` must be flipped to `true` for real settlements
   to happen (Jason gate — see Phase 9 handoff procedure).
3. At least one real paid call must settle through the CDP facilitator for the
   endpoint to be indexed.

---

## How to verify after settlement traffic exists

```bash
# Check CDP Bazaar for Suede Agent Studio
curl "https://api.cdp.coinbase.com/bazaar/v1/services?search=suedeai" \
  -H "Accept: application/json"

# Or browse: https://www.coinbase.com/developer-platform/bazaar
```

---

## Notes

- x402.org ecosystem page is CLOSED to manual submissions (confirmed Jun 2026).
- CDP Bazaar is the only major directory with auto-listing via settlement.
- No manual submission file is needed — listing is a side-effect of live traffic.
- Jason: flip `settlement_live=true` on one agent, run a paid call through the
  CDP facilitator, then check Bazaar ~24h later.
