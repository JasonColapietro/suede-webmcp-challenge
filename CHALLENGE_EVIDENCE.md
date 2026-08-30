# WebMCP Challenge evidence

Evidence freeze: August 30, 2026, America/New_York.

## Project

- Name: Suede Agent Studio WebMCP Storefront
- Live URL: https://agents.suedeai.ai/agents
- Public source: https://github.com/JasonColapietro/suede-webmcp-challenge
- License: MIT
- Runtime: Next.js 15, React 19, TypeScript

## What changed during the challenge window

Suede Agent Studio existed before the challenge. The WebMCP storefront is the
meaningful extension added after the challenge opened on August 25, 2026.
This repository preserves that distinction as reviewable commits:

- `f4943a1` — pre-WebMCP application baseline.
- `e2c3b11` — adds the page-scoped WebMCP storefront: 17 files, including the
  four tool descriptors, browser registration, server purchase route, safety
  guards, with 70 focused tests passing in the current snapshot.
- `a3497fe` — hardens rate limiting and price binding, preserves purchase
  receipts, improves discovery against live shelf behavior, and adds focused
  regression coverage.
- `c4db4b1` — synchronizes the runnable challenge snapshot with the current
  application source.

Review the feature directly:

```bash
git diff --stat f4943a1..e2c3b11
git diff f4943a1..e2c3b11 -- src/lib/webmcp src/components/webmcp src/app/api/webmcp tests/webmcp-*.test.ts
git diff --stat e2c3b11..a3497fe
```

## WebMCP implementation map

| Concern | Source |
| --- | --- |
| Browser API compatibility and field budgets | `src/lib/webmcp/protocol.ts` |
| Four fixed tool contracts and result formatting | `src/lib/webmcp/storefront.ts` |
| Browser registration and same-origin execution | `src/components/webmcp/StorefrontTools.tsx` |
| Server-owned buy schema | `src/lib/webmcp/buy-contract.ts` |
| Origin, rate-limit, price, and buyability guards | `src/lib/webmcp/buy-guard.ts` |
| Paid-call route and receipt preservation | `src/app/api/webmcp/buy/route.ts` |
| Public mounts | `src/app/agents/page.tsx`, `src/app/a/[slug]/page.tsx` |
| Focused regression coverage | `tests/webmcp-*.test.ts` |

The tool set stays constant as inventory grows:

```text
find_services -> get_service -> preview_service -> buy_service
```

This avoids registering one tool per service, keeps every name within WebMCP's
budget, and requires an agent to inspect the service contract before preview or
purchase.

## Human-agent experience

Before WebMCP, an agent in a browser had to infer buttons and fields, while the
machine payment routes required credentials or signing capability that page
JavaScript intentionally could not access. The WebMCP storefront lets the
agent discover and inspect services using the visitor's current page context.
The human keeps the meaningful boundary: a preview is free but recorded, and a
purchase uses only prepaid workspace credit with the exact accepted price
echoed and rechecked server-side.

The challenge demo stops after the free synthetic preview. It does not execute
`buy_service`, spend credit, move USDC, or require private data.

## Live evidence

On August 30, 2026, the public `/agents` page loaded successfully in ChatGPT's
in-app browser and exposed:

- `find_services`
- `get_service`
- `preview_service`
- `buy_service`

A live read-only query for vendor-contract review returned three matching
services. `get_service` then returned the selected service's exact price, input
schema, review-policy boundary, data-handling statement, example input, and
example output. The public shelf reported six services, all with a free preview
available.

## Safety boundaries demonstrated

- Tools are mounted only on `/agents` and `/a/[slug]`, not globally.
- Creator-authored catalog text is annotated as untrusted content.
- Read-only annotations are used only for discovery and contract inspection.
- Preview is labeled as a write because it records a durable run.
- Purchase authority remains server-side.
- The server validates mutation headers and request size before execution.
- Rate limiting runs before expensive catalog and identity work.
- The client must echo the accepted price; the execution layer enforces that
  value as a maximum before ledger movement.
- Purchase responses preserve `runId` and `chargedUsdc` ahead of bounded output.
- The challenge demo uses synthetic data and does not call the purchase tool.

## Local verification

Use Node.js 24.19.0, matching repository CI:

```bash
npm ci --no-audit --no-fund
npx tsc -p tsconfig.ci.json --noEmit
npm run lint
npm test -- --run tests/webmcp-protocol.test.ts tests/webmcp-shelf-contract.test.ts tests/webmcp-storefront.test.ts tests/webmcp-preview-budget.test.ts tests/webmcp-buy-guard.test.ts tests/webmcp-mount-scope.test.ts
npm run build
```

Default local operation uses SQLite and dry-run settlement. No production
credentials are required for the build or focused WebMCP tests. Never place
real credentials in `.env.example`, commits, issues, demo footage, or logs.
