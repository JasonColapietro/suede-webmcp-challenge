# WebMCP Challenge evidence

Last verified: September 3, 2026 17:38 UTC (13:38 America/New_York).
Release status: frozen judge deployment public and verified on `webmcp.suedeai.ai`.

## Project

- Name: Suede Agent Studio WebMCP Storefront
- Frozen judge URL: https://webmcp.suedeai.ai/agents (public, verified)
- Rolling production URL: https://agents.suedeai.ai/agents (tracks `main`)
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
  guards, with 70 focused tests in the original challenge snapshot.
- `a3497fe` — hardens rate limiting and price binding, preserves purchase
  receipts, improves discovery against live shelf behavior, and adds focused
  regression coverage.
- `c4db4b1` — synchronizes the runnable challenge snapshot with the current
  application source.
- `c6193bb` — accepts both Promise-returning native registration and
  synchronous browser bridges, prevents one registration failure from blocking
  later tools, and adds regression coverage. The focused suite now has 71
  passing tests.

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

## Current browser evidence

The earlier September 1 four-tool claim is superseded by the subsequently
reported synchronous-registration failure and the fresh verification below.
It is not evidence that registration remained healthy across browser versions.

After compatibility fix `c6193bb`, fresh Codex in-app browser tabs on
`/agents` and `/a/po-match-gate-mkgu0` exposed all four page-defined tools:

- `find_services`
- `get_service`
- `preview_service`
- `buy_service`

A live `find_services` call for purchase-order and invoice comparison returned
three matches. `get_service` returned PO Match Gate's exact 0.05 USDC price,
required `purchaseOrder` and `invoice` fields, human-review boundary, data
handling, and synthetic examples. The return-shape schema was explicitly
omitted by the output budget; the response did not claim to inline it.

WebMCP exposes **six curated services from the 31-listing directory**. The
curated `/api/services` shelf and the full directory are different scopes.

The latest synthetic `preview_service` call returned run
`ab8cc02c-868d-46b1-b7b7-d8af9a82462d`, `status: done`, `totalCostUsdc: 0`,
`settled: false`, and `mode: dry-run`. Its output states that the LLM call was
skipped and no provider request was made. No browser console errors were
captured in that tab. `buy_service` was not called.

## Frozen deployment preparation

- Runtime source: `7234b99595bbdc886e1e124592c1e539034962a6`.
- Release branch: `release/webmcp-2026-final` in this public repository and
  the connected application repository. Both branches are locked, including
  administrators; force pushes and deletion are disabled.
- Dedicated Vercel deployment: `dpl_HZ1BAH9J4N969dFe8hGQCaKfEdZP`, READY.
- Deployment hostname: `agentix-7mxa34eyz-suede-ai-64d39175.vercel.app`.
  This hostname is protected and is not the judge URL.
- Challenge domain: `webmcp.suedeai.ai`, explicitly assigned to the release
  branch rather than the project's normal production branch.
- Both build-time and runtime `NEXT_PUBLIC_SITE_URL` point to the challenge
  origin. Deployment used `--prod --skip-domain`; the normal production domain
  remained on `dpl_G3WtPNFFEM85qZEAV41SooN26ymi`.
- DNS: GoDaddy CNAME `webmcp` -> `cname.vercel-dns.com`, live on the
  authoritative nameservers and public resolvers. Certificate issued.
- Domain assignment: `webmcp.suedeai.ai` is bound to the release branch on the
  project and explicitly aliased to `dpl_HZ1BAH9J4N969dFe8hGQCaKfEdZP`. Two
  later `main` production deploys (#387, #388) did not move it.
- Public access: Vercel Authentication was disabled on the project so the
  branch-bound domain is served without SSO. Standard protection exempted only
  production custom domains; per-domain exceptions require a paid add-on.
- Verification at 07:30 UTC, logged out, from a fresh automation browser:
  `/`, `/agents`, `/a/po-match-gate-mkgu0`, and `/api/services` return 200;
  served asset URLs carry `dpl_HZ1BAH9J4N969dFe8hGQCaKfEdZP`; canonical and
  `og:url` resolve to `https://webmcp.suedeai.ai`. All four tools registered
  on `/agents` (`navigator.modelContext`, synchronous `registerTool`) and on
  the listing page (`document.modelContext`, Promise-returning `registerTool`).
  `find_services` returned 3 of 6, `get_service` returned the PO Match Gate
  contract, and the synthetic `preview_service` call returned run
  `2a1e8aa8-5a72-4041-82c6-8d00152a7287`, `status: done`, `totalCostUsdc: 0`,
  `settled: false`, `mode: dry-run`. No console errors. `buy_service` was not
  called. Adversarial inputs (unknown and path-like slugs, missing field,
  oversized body, wrong body type, injection text in `need`) were rejected or
  treated as plain text by the server.

This is a separate fixed deployment in the existing project, using the
existing hosted database. It does not clone or freeze that database. The six
curated service contracts and published flows must also remain unchanged
through judging; preview receipts and usage counters remain dynamic.

The custom domain and four-tool flow are verified. Both Devpost live-URL fields
and the URL in testing instructions now point to the frozen judge URL. The final
video remains to be updated before the deadline. The deadline is September 3 at
20:00 UTC / 1:00 PM PDT / 4:00 PM EDT. Keep the submitted repository, video,
deployment, and relevant service configuration unchanged through September 21
at 5:00 PM PDT (September 22 at 00:00 UTC), per the
[challenge updates](https://webmcp.devpost.com/updates).

## Submission readback

The existing [Devpost project](https://devpost.com/software/suede-agent-studio-webmcp-storefront)
was verified as **SUBMITTED, 5/5 steps done**. The description now states the
six-versus-31 scope, 71 focused tests, and synchronous registration fix.
Judge instructions include exact synthetic input and stop after the free
preview. Public and judge-only live-URL fields, plus testing-instruction step 1,
were read back as `https://webmcp.suedeai.ai/agents`. The existing video remains
https://youtu.be/ZR1At7lX6-E until the replacement is verified and uploaded.
A replacement recut has been rendered locally as a 120-second, 1920×1080
H.264/AAC video (SHA-256
`c7724b1e3381b31af3a157f1c0e69d12dda32a141ec6f6374d692f560b9eb9d9`). It
opens on discovery, presents captured results as edited panels, and preserves
the explanation that the preview performs no inference. The rendered end card
was visually verified with `webmcp.suedeai.ai/agents` and the public repository
URL. The recut is not yet uploaded.

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
