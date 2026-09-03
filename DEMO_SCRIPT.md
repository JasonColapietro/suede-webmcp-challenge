# WebMCP Challenge demo script

Target: **2:00**. Open on the working tool flow with all four tool names visible.
Use synthetic data only. Do not call `buy_service`.

## 0:00–0:15 — discover immediately

Show `find_services` with:

```json
{"need":"compare a purchase order with an invoice","limit":3}
```

Show the returned PO Match Gate result and 0.05 USDC price. State that the
four WebMCP tools expose **six curated services from the 31-listing directory**.

## 0:15–0:33 — inspect the contract

```json
{"slug":"po-match-gate-mkgu0"}
```

Show `get_service` returning required `purchaseOrder` and `invoice` strings,
the exact price, human-review boundary, data handling, and worked example.
The browser result can explicitly omit oversized return-schema details.

## 0:33–1:12 — synthetic preview and receipt

Call `preview_service` with:

```json
{
  "slug":"po-match-gate-mkgu0",
  "input":{
    "purchaseOrder":"PO-9920: 100 widget-A units at $2.50, total $250.00.",
    "invoice":"INV-7781 for PO-9920: 100 widget-A units at $2.65, total $265.00."
  }
}
```

Distinguish the contract's worked $15 discrepancy example from the actual
dry-run output. Show `status: done`, `totalCostUsdc: 0`, `settled: false`, and
`mode: dry-run`. Explain that a run is recorded but no model request or
payment occurs.

## 1:12–1:29 — explain the four-tool contract

Show `find_services`, `get_service`, `preview_service`, and `buy_service`.
Discovery and inspection are read-only; preview and purchase are writes.
Inventory can grow while the tool set stays constant. Keep `buy_service`
visibly labeled **not called**.

## 1:29–1:56 — human control and server checks

Explain page-scoped registration, same-origin calls, synchronous/Promise
browser compatibility, server origin/rate limits, fresh availability, and
exact-price checks. The user keeps the payment decision; this demo stops at
the free preview.

## 1:56–2:00 — links

Show the public MIT repository and the verified frozen judge URL. The
prepared destination is `https://webmcp.suedeai.ai/agents`; do not publish a
video pointing to it until DNS, public access, and the tool flow pass.

When using designed panels made from actual tool results, label them
**Captured results · edited for clarity**. Do not present them as an unedited
screen recording. Preserve the old upload until the replacement is ready.
