# Play ASO — `ai.suede.agents`

Researched 2026-08-10. **No ASO doc existed before this one.** Every prior
listing decision (title, short-description lead, category) was undocumented,
and at least two of them were wrong.

## Verdict: minimal effort. Play is a low-value channel for this product.

This is a developer/prosumer tool. The measured ceiling is not a demand number,
it is a competition number: **every app on Play whose value proposition assumes
the user already understands agents, workflows or endpoints sits between 10 and
5,000 installs with essentially zero ratings.** Impresiv 5K/0 ratings, n8n
Manager 1K/2.17 stars, AgentsRoom 500/0, Automation Studio AI 500/0, AgentBoard
100/0, Voice Agent Builder 10/0.

The nearest structural analog — a phone companion to a workflow platform whose
real surface is desktop — is **n8n Manager, the worst-rated app in the space.**

Ranking here is confirmed *not* install-gated (dev.aitelier.builder at 10
installs ranks #9 for `agent builder`; ClawShop at 50 installs holds #1 for
`ai agent marketplace`; a 1K-install app outranks Manus AI at 10M+ for
`ai agent`). But that cuts *against* investment: a 10-install app holds page one
because there is no traffic to ration. Winning position 3 instead of 12 on a
query whose entire winner cohort tops out at 1K installs is worth a few hundred
installs, not a few thousand.

**Do the cheap corrections below and stop.** Route effort to
agents.suedeai.ai and developer channels, where the long tail actually lives —
that tail is dominated by courses, certifications, jobs, salaries, GitHub and
enterprise vendors, i.e. browser and desktop, not Play.

## What was changed (2026-08-10)

| Field | Before | After | Chars |
|---|---|---|---|
| Title | `Suede Agent Studio: AI Agents` | `Suede AI Agents: Directory` | 29 → 26 |
| Short description | `Hire AI agents by the call, or launch your own as a priced, callable endpoint.` | `An AI agent directory for your phone: browse, try free, track runs and spend.` | 78 → 77 |
| Full description | (see git history) | rewritten for placement | 2260 → 2615 |
| Category | Business | **Productivity** | — |

Counts are Unicode code points, measured with
`python3 -c "print(len(open(F,encoding='utf-8').read().rstrip('\n')))"`.
`wc -m` without `LC_ALL` counts bytes and lies about the em dashes in this file.

### Title

`Studio` measured 0 exact-title matches out of the top 14–30 results for the
query `agent studio`, and Play resolves that query semantically to generic
AI-agent apps. It was 7 of 30 characters carrying zero ranking weight.
`Directory` is near-uncontested (0–1 of 20–30 exact) **and** is the honest
shape of the phone build — which matters more, because it sets a
directory-shaped expectation before install and Play ranks on retention.

Tradeoff, stated plainly: the product is named Suede Agent Studio and the title
no longer contains that name in full. It survives in the first line of the full
description and on the icon. This is a brand call, not an ASO call — the ASO
case is unambiguous. The listing has never been published (`BLOCKERS.md`), so
there is no ranking history to protect.

### Short description

`Hire AI agents by the call` was spending the highest-leverage 78 characters in
the listing on the wrong buyer. Autosuggest for `hire ai agent` returns
`…developer` (2), `…builder` (3), `…development company` (4), `…engineer` (5),
`hire ai agency` (8) — B2B services procurement, people looking to hire humans
to build agents. `callable endpoint` was also cut: `endpoint`, `nodes`, `x402`,
`USDC`, `provenance` and `royalty routing` appear **zero times across 4,341
mined competitor reviews.**

The count-free variant was chosen deliberately. `Browse 30 live AI agents`
tested better, but **30 has no backing constant anywhere in the repo** — the
only live figure is computed at runtime (`liveAgentCount`,
`src/app/company/page.tsx:1638`). An unverifiable number is the same review
exposure as a false one. If someone pins the published directory count with a
test, the numeric variant becomes available.

Per-call hiring is still a real feature and still appears in the body. The
placement was killed, not the feature.

### Full description

Opener rewritten to fit entirely inside the ~167 characters shown before
"Read more" (166 code points measured). It previously spent its first 19
characters repeating the brand already displayed directly above it, led with
invented vocabulary ("control room", zero occurrences in 4,341 reviews), buried
the free trial behind a 100-character preamble, and pushed "— from your phone"
past the truncation point where nobody sees it.

Density: 6 exact `AI agent` matches in 2,615 characters, one per 436. The 2026
guidance is roughly one per 250, so this is still **under**-optimized, not
stuffed. Section headers now carry exact matches. 1,385 characters remain
unused if anyone wants more.

## Keyword decisions

| Term | Verdict | Placement |
|---|---|---|
| `AI agents` (head term) | Keep. 16/20 of top 20 carry it; provably not install-gated | Title + opener |
| `ai agent app` / `…for android` | **The one term with genuine Play install intent.** 0/20 exact title matches, N=29 | Full description, header |
| `AI agent directory` | Near-zero title competition (0–1 of 20–30), but Play serves the same generic set for it — ranking gain ≈ 0. Used for honesty and retention, not discovery | Title + opener |
| run history / spend / earnings | Uncontested; only AgentBoard (100 installs) competes | Short desc + body |
| free / dry-run | The wedge. Verified real at `src/app/api/agents/[agent]/run/route.ts:252` | Opener + body |
| `ai agent marketplace` | Cheap, marginal | Prose only |
| `agentic AI`, `ai employees`, `automation`, `agent workflow` | Real vocabulary, no ranking value | Prose only |

### Killed

- **`ai agent builder` / `visual workflow builder`** — the single best measured
  opportunity anywhere in the harvest (autosuggest rank 1, 0/30 exact title) and
  we cannot honestly take it. `src/app/build/[flowId]/page.tsx:4789` renders
  "The studio wants a bigger canvas." on a phone. This is a **product** gap, not
  a copy gap. Do not delete the honest phone-canvas paragraph to make room for
  the claim. Separately, 6–8 of the top 15 autosuggest results are Microsoft
  certification and career intent.
- **The whole earnings cluster** (`make money with ai`, `ai side hustle`,
  `passive income ai`) — highest raw consumer demand in the harvest, killed by
  one grep: **zero Play Billing anywhere in `ios-app/android`**, so nothing can
  be sold on Android. Play search for `ai agent earn crypto` returns a
  faucet/miner neighbourhood; ranking into it imports that audience and its
  review behaviour. *Flag for the iOS lane:*
  `ios-app/AppStore-Submission/metadata/en-US/keywords.txt` still carries
  `passive income`.
- **`x402` as a discovery term** — Play returns 8 total results, none relevant;
  it cannot even fill a result page. **This is a placement kill, not a claim
  kill.** x402 / USDC / Base / provenance / programmable IP / royalty routing
  are true and differentiating and stay in the full description exactly as
  written.
- **`automation builder`** — belongs to ABB industrial PLC software. Play
  returns two factory-building games.
- **`no code`, `build apps with AI`, `app builder`** — wrong intent, and `no
  code` appears zero times in 768 positive reviews of the two apps that lead
  with it.
- **`pay per call`** — Play parses this as telephony (PayCall, CaptionCall).
- **`chatbot`** — not what this is.

## Wedge: pay-for-attempts, not results

Share of each competitor's 1–2 star pool mentioning credits, paywall, pricing or
refunds — **within-pool percentages only**; the rating sort over-samples
negatives, so pool *size* is not a base rate:

| App | Share |
|---|---|
| Manus AI | 67.3% (171/254) |
| Replit | 54.3% (101/186) |
| Base44 | 41.6–43.8% |
| Fig | 25.0–35.7% |
| MiniMax | 17.4% (12/69) |
| Taskade | 13.3% (21/158) |

The same pattern appears in only 1.7–12.9% of those apps' 4–5 star pools, so it
is a genuine negative concentration, not a corpus-wide artifact. `credits` is
the #5 most frequent unigram across the whole 4,341-review corpus.

We can honestly attack this: dry-run is genuinely free (verified in source),
per-unit prices are published before you spend (no competitor does this), and
per-call is structurally different from a credit meter. **The caveat matters
more than the wedge:** no Play Billing means nothing can be sold on Android at
all right now, so this is a differentiator with an expiry date — and the topup
surface is itself a policy problem (below), not a feature.

**Do not attack the desktop-vs-phone axis.** It is the #2 complaint pattern in
the category and it is our own weakness. Base44 eats a 10.4% within-negative-pool
small-screen hit *with* a fully working phone build.

## Claims verified against source — do not "clean these up"

| Claim | Status | Evidence |
|---|---|---|
| 87 agent templates | **True** | `SEED_TEMPLATES.length === 87` |
| across 8 business departments | **Was imprecise, now corrected** | 8 departments exist (Ops 18, Marketing 15, Sales 12, Engineering 11, Support 8, Finance 7, HR 3, Legal 2 = 76); the other 11 are personal/creator templates. Copy now says "8 business departments plus personal and creator picks" — additive, nothing removed |
| try any free in dry-run | **True** | `run/route.ts:252` gates all settlement behind `if (!dryRun && agent.priceUsdc > 0)` |
| priced $0.02–$0.50 | **Was wrong, now corrected** | Template floor is **$0.01**, not $0.02 (listing under-claimed); ceiling $0.50 exact. More importantly `src/lib/site/pricing.ts:6` records that static $0.02–0.05 defaults were replaced because they priced calls ~4x under model cost — site-drafted agents now carry a cost-derived floor near $0.087. Copy now attributes the range to the template catalog, which is exactly what it describes |
| phone canvas needs a larger display | **True, and load-bearing** | Kept verbatim. It is the listing being honest about a real constraint on the exact form factor Play reviewers test |
| device permissions | **Nothing overclaimed** | `AndroidManifest.xml` requests `INTERNET` only |

## Build tasks this pass surfaced

1. **Highest value: phone `/build` dead-ends.** `page.tsx:4789` shows a refusal
   headline first. It *does* already offer "Build with Guided mode →", "Browse
   the directory →" and an "Open compact canvas anyway" override — better than
   the listing implies — but a reviewer opening `/build` on a phone reads the
   headline, not the buttons. Lead with guided mode instead of with the refusal.
   This unlocks `visual workflow builder` (autosuggest rank 1, 0/30 exact,
   completely open) and it is the #2 complaint pattern in the category.
2. **Policy blocker: non-Play payment path reachable in the Android webview.**
   `content-rating-and-audience.md` answers **Yes** to digital-goods purchase
   ($5–$250 tiers), but `git grep -in 'billingclient|BillingFlow|play billing'
   -- ios-app/android` returns **zero hits**, and the topup surfaces are live
   (`src/app/api/gateway/topup/route.ts`, plus Stripe card checkout advertised
   at `src/app/.well-known/agent-card.json/route.ts:26-27`). This is a Capacitor
   shell loading agents.suedeai.ai, so those surfaces ship. Wire Play Billing or
   gate them out of the Android webview and answer **No**.
3. **Pin the directory count** with a test if the numeric short description is
   ever wanted back.
4. **Listing copy is slightly loose on guided mode** — it says the studio
   "opens in guided mode" on a phone; in fact the guard screen *offers* guided
   mode as a button. Understatement, not overstatement, so left verbatim per the
   do-not-soften rule. Worth tightening whenever build task 1 lands.
