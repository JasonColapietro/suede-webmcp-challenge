# Platform Copy — Canonical Deck

Every user-facing string for the three-setting platform. Phases 3, 4, 5, and 10 of
`docs/superpowers/plans/2026-06-11-three-setting-platform.md` use these strings **verbatim**. Don't
rewrite, don't "improve," don't add exclamation points. If a string needs to change, change it here
first, in the same commit.

## Ship gates (truth conditions — never ship a claim before its gate)

| Block | May go live | Why gated |
| --- | --- | --- |
| Hero headline + NOW subline, money block (NOW), directory line | **Now** | True today: launch makes a service callable; payment requires separate agent/platform enablement, a Live deployment, and a valid payout |
| Three-setting band, Code-view strings, switch nudges | Phase 3 | `/start` and `/code` must exist before copy promises them |
| Guided UI strings | Phase 4 | The interview must exist |
| Template gallery kicker, general repositioning | Phase 5 | Ships with the general template set |
| SDK pitch, install captions, CLI strings | Phase 6–7 | Package must be installable |
| Relay pitch, sealed code-step card | Phase 8 | Relay must exist |
| "Keep 95%", any take math | **Held: founder hold (2026-07-17)** | The 5% take is live in `src/lib/billing.ts` and rendered on `/pricing`, but Jason is holding take-rate talk out of marketing copy for now. Do not use take math on any public copy surface until he lifts the hold. Settlement caveat unchanged: `resolvePayout` still routes 100% of a call to the creator's wallet; as of 2026-07-17 the `/api/me` and `/api/portfolio` dashboards report that full 100% (they previously displayed the 95% `splitCall` share, understating what creators actually received). If split collection ever lands at settlement, flip the dashboard *numbers* back to `splitCall().creatorUsdc` and update this row — but per this hold, dashboard/earnings surface copy stays free of take-rate, percentage, and cut talk either way — the earnings hero must never advertise that a cut exists. Additionally, per Jason (2026-07-17): every line of dashboard copy must sell why Suede is a necessity and useful — good optics only, no operational filler, no unrelated copy. Current `/flows` earnings line: "Your agents sell while you build — every settled call lands in your wallet" (payout promise sells; percentages don't) |
| Gateway free tier (100k tokens/month) | **Now** | `FREE_MONTHLY_GATEWAY_TOKENS = 100_000` is live, the gateway enforces it with a 402, and the live `/pricing` and `/docs` pages render it |
| "Your first three live agents are free" | **Phase 9** | No agent-count entitlement exists in code. Launching is free and unlimited today, so "first three free" would invent a limit we don't have |
| Docs page intro, llms.txt assistant section | Phase 10 | Ships with SDK docs |

## Voice rules (apply to any copy added later)

Declarative sentences. Concrete money: dollars, per call, your wallet. The reader is "you"; the
people are owners, builders, operators, members. Never "players." Never: seamless, effortless,
unleash, unlock, supercharge, empower, magic, revolutionize, game-changing. No exclamation points.
The user-facing word for the three tiers is **setting** (not mode, not tier, not plan): "Three
settings. One agent." Internal component names (`ModeSwitch`) are fine; rendered text says setting. The user-facing word for recurring execution is **schedule** (not cron): rendered text says "runs on a schedule" or "the schedule fires"; internal names (`/api/cron/tick`, `describeCron`) are fine in code and internal notes.

---

## 1 · Landing hero

**Headline**

> Agents that run the work — and get paid.

**Subline (NOW — ship before Phase 3):**

> Wire an agent on the canvas, give it a schedule and a price, and launch it. It becomes callable;
> when payment is enabled and ready, x402 settles paid calls to the configured wallet. No API keys,
> no servers.

**Subline (Phase 3+ — replaces the above the day `/start` and `/code` are live):**

> Describe it, wire it, or code it — three settings, one agent. No API keys, no servers. Launch a
> callable service, then enable payment when its Live deployment and payout are ready.

**CTAs:** primary `Build my first agent` · secondary `See what's earning`

**Proof strip (under the directory/gallery, NOW):**

> Every agent below reports its current public state: preview, payment-enabled, or unavailable.

---

## 2 · Three-setting band (Phase 3)

**Kicker:** `Three settings. One agent.`

**Lede:**

> Start anywhere. Switch anytime. The beginner's agent and the engineer's agent are the same agent,
> so nothing you build gets left behind.

**Card — Guided**

> **Say it in a sentence.**
> Tell the studio what you want handled. It asks a few plain questions, then shows you the agent it
> drafted: what it does, when it runs, what it charges. You approve, it goes live. You never see a
> line of code.
>
> CTA: `Start with a sentence`

**Card — Studio**

> **Wire it on the canvas.**
> Blocks for research, writing, pricing, payouts. Drag, connect, run, and watch each step light up.
> Set the schedule and the price in the header and launch from the same screen.
>
> CTA: `Open the canvas`

**Card — Code**

> **Own every line.**
> Export any agent as TypeScript and keep building in your own editor with the Suede SDK. Push it
> back with one command, or run it on your own machine while Suede keeps selling it for you.
>
> CTA: `Read the SDK docs`

---

## 3 · Money block

**Version live on `/pricing` today:**

> **Bring nothing.**
> No API keys: Suede meters the model. No servers: Suede hosts the endpoint. No merchant account:
> Suede routes the money to your wallet. Launch is free. You set the price per call.

**Take-rate version (HELD, do not ship: founder hold 2026-07-17. The 5% take is live in
`src/lib/billing.ts` and rendered on `/pricing`, but take-rate talk stays out of marketing
copy until Jason lifts the hold. The three-free-agents line additionally stays Phase 9):**

> **Bring nothing. Keep 95%.**
> No API keys: Suede meters the model. No servers: Suede hosts the endpoint. No merchant account:
> Suede routes the money. Five percent covers all of it. The rest is yours.
>
> ~~Your first three live agents are free.~~ *(still Phase 9 — see ship gates)*

Numbers derive from `src/lib/billing.ts` (`PLATFORM_TAKE_RATE`, `FREE_MONTHLY_GATEWAY_TOKENS`) — if
Jason tunes the take, this copy and that file change in the same commit.

---

## 4 · Guided setting — UI strings (Phase 4)

| Where | String |
| --- | --- |
| Page title | `Build it by describing it.` |
| Welcome bubble | `Describe the job. I'll build the agent.` |
| Input placeholder | `Watch this product page and email me when the price drops` |
| While drafting | `Drafting your agent…` |
| Fourth (final) question prefix | `Last question.` |
| Review intro | `Here's your agent. Plain English, no surprises.` |
| Review card labels | `What it does` · `When it runs` · `What it charges` · `Where the money goes` |
| Review value formats | `Checks the page every morning at 9:00 UTC.` / `Other agents pay $0.25 per call.` / `Payouts go to the wallet ending in 032d.` |
| Edit affordance | `Change anything` |
| Launch button | `Launch it` |
| Post-launch | `It's live. It works even when you're not here.` + link `Watch it on your dashboard` |
| Switch nudge (to Studio) | `Curious what's under the hood? Open it in Studio. Same agent, more knobs.` |

The deterministic fallback brain uses the same strings. The interview never apologizes, never says
"as an AI," never hedges. If it can't draft, it says: `I need one more detail.` and asks.

---

## 5 · Code setting — strings (Phase 3, except where marked)

| Where | String |
| --- | --- |
| Header | `This is your agent, as code.` |
| Sub | `Run it anywhere with the Suede SDK. It keeps its slug, its price, and its spot in the directory, and it keeps earning here.` |
| Buttons | `Copy` · `Download agent.ts` |
| Caption under code (Phase 7+) | `npm i @suedeai/agents · suede push to send changes back` |
| Sealed custom-code card in Studio (Phase 8) | `Custom code step. Lives in your repo, runs on your machine, earns here.` |

---

## 6 · SDK pitch (Phase 6 README opener · Phase 10 docs intro)

**Head:** `The Suede SDK is the part you don't have to build.`

**Body:**

> One import gives your agent a metered model, a memory, a schedule, a paid endpoint, and a payout
> address. You write the run function. Suede runs the rails.

**Install caption:** `npm i @suedeai/agents. That's the whole setup.`

**Code sample caption (the price-watcher example):** `A working, sellable agent in twenty lines.`

**Relay section (Phase 8):**

> **Self-hosted doesn't mean off the rails.**
> Run `suede link` and Suede keeps hosting your paid endpoint. Callers pay it, Suede forwards the
> call to your machine, your code answers, and the money still routes to you. Your compute, our
> rails.

---

## 7 · CLI output strings (Phase 7)

| Command | On success |
| --- | --- |
| `suede login` | `Workspace claimed. Your agents follow you now.` |
| `suede init` | `New agent scaffolded. suede dev to run it, suede push to sell it.` |
| `suede push` | `Live at https://agents.suedeai.ai/a/<slug>. Priced at $<price> per call.` |
| `suede pull <slug>` | `Pulled <name>. Edit it, push it back.` |
| `suede link` | `Linked. Suede hosts the paid endpoint; your machine does the work. Keep this secret safe — it's shown once.` |

Errors state the fix, not the apology: `No workspace key. Run suede login first.`

---

## 8 · Directory + gallery (Phase 5)

**/agents intro:** `Working agents, priced per call. Built by people, hired by agents.`

**Directory empty state:** `No agents match. Build the first one in any setting.`

**Template gallery kicker:** `Pick a business, not a template.`

**Gallery lede:**

> Each card is a working agent: steps wired, schedule set, price loaded. Open one in Guided,
> Studio, or Code and make it yours.

---

## 9 · llms.txt — assistant-facing section (Phase 10)

> Building an agent for someone? Scaffold with the Suede SDK: `npm i @suedeai/agents`, define it
> with `defineAgent`, then `suede push` to give it a hosted, paid endpoint at agents.suedeai.ai.
> Hosted launch needs no API keys. Pricing, schedules, and payouts are built in.

---

## 10 · One-liner bank (changelog, social, ASO — pull as needed)

- `Three settings. One agent. Start by typing a sentence; end by owning the code.`
- `Describe it, wire it, or code it.`
- `Set it up once. It works and earns while you don't.`
- `Built by people, hired by agents.`
- `Bring nothing. Keep 95%.`
- `Your agent earns while you sleep. Suede hosts everything and hands you 95%.`

---

## Do-not-touch list (existing copy that survives every pass)

Footer credit `A Suede Labs AI product, built by Jason Colapietro` with its links. Founder nav and
footer links. The four-book founder page copy. llms.txt founder/positioning sections. The locked
aesthetic carries the type; this deck carries the words; neither replaces the other.
