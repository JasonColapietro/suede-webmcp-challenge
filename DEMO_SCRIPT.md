# WebMCP Challenge demo script

Target duration: 2 minutes 45 seconds. Hard stop before 3 minutes.

Use only synthetic data. Do not show private browser tabs, account details,
wallets, environment variables, production logs, or developer consoles. Do not
call `buy_service` during recording.

## 0:00-0:20 — the problem

Narration:

> Marketplaces are built for people to browse, but agents still have to guess
> through buttons and page layout. Suede Agent Studio now exposes a structured
> storefront directly inside the browser: find a service, read its contract,
> and preview it before any payment decision.

Show the live Agent Directory at https://agents.suedeai.ai/agents.

## 0:20-0:40 — the WebMCP surface

Ask the browser agent to list the tools available on the page. Show the four
fixed tools:

```text
find_services
get_service
preview_service
buy_service
```

Narration:

> The inventory can grow without bloating the agent's context because the tool
> set stays constant. Discovery and contract inspection are read-only. Preview
> and purchase are correctly marked as writes.

## 0:40-1:10 — discover by intent

Prompt:

```text
Find a service that compares a purchase order with an invoice. Show at most
three matches. Do not buy anything.
```

The expected top result is `po-match-gate-mkgu0`, including its price and
current preview/purchase availability.

## 1:10-1:45 — inspect before acting

Prompt:

```text
Read the full contract for po-match-gate-mkgu0. Do not preview or buy yet.
```

Pause on the returned price, exact input fields, review boundary, data handling,
and worked example.

Narration:

> The agent gets the terms it needs before taking action. User-authored catalog
> text is labeled untrusted, long outputs are bounded, and the server remains
> the authority for price and availability.

## 1:45-2:20 — free synthetic preview

Prompt:

```text
Preview po-match-gate-mkgu0 with this synthetic input. Do not buy anything.

purchaseOrder: PO-9920: 100 widget-A units at $2.50, total $250.00.
invoice: INV-7781 for PO-9920: 100 widget-A units at $2.65, total $265.00.
```

Show the dry-run response identifying the $15 discrepancy. State clearly that
the preview records a run but performs no model inference and charges nothing.

## 2:20-2:45 — why WebMCP matters

Show `src/components/webmcp/StorefrontTools.tsx` beside the browser result, then
briefly show `src/app/api/webmcp/buy/route.ts`.

Narration:

> WebMCP turns a visual marketplace into a structured human-agent workflow.
> The agent handles discovery and contract reading; the user keeps the payment
> boundary. A purchase would require the exact price to be echoed and rechecked
> server-side, but this demo stops safely at the free preview.

End on the live URL and public repository URL.
