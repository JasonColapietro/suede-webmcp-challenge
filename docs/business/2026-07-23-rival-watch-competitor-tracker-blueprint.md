# Rival Watch autonomous-company blueprint

## Business definition

- **Business:** A competitive-intelligence service that produces a weekly, named-competitor brief for each of the five rivals Suede's own `/vs` pages already name — Suno, DistroKid, Audius, Story Protocol, and Patchbay. It is built on Suede Agent Studio's **Competitor Tracker** template (`tpl-competitor-tracker` in `src/lib/templates.ts`), fixed in this session so its prompt actually names the specific tracked competitor instead of reading generically.
- **Buyer:** Two buyer segments, both real given the confirmed x402 pricing/discovery mechanism: (1) Suede Labs AI itself, using the briefs to keep its `/vs` pages current; (2) any external caller who discovers the agent through the platform's x402 listing and pays per call — music-industry operators, VCs, or founders who want a standing read on these five companies without doing the digging themselves.
- **Nightly/weekly loop:** Weekly, not nightly — cron `0 8 * * 1`, confirmed to mean Monday 8:00 AM UTC, and confirmed consistent with three other places on the template's own landing page (step copy, page header, and metadata description all independently say "Monday" / "weekly").
- **Money surface:** x402 pay-per-call at 0.15 USDC per call, one call per competitor brief. Every agent is created `settlementLive: false` by default and stays that way through activation — so this money surface exists in configuration from day one but does not collect real USDC until a human explicitly flips the per-agent settlement toggle **and** the platform-wide `X402_SKIP_SETTLEMENT` is set to `"false"`.

## Staff roster

| Role | Agent or flow | Template or custom | Trigger | Input | Output | Buyer | Endpoint |
|---|---|---|---|---|---|---|---|
| Suno tracker | 1 agent instance of Competitor Tracker, `web.fetchUrl.url` set to Suno's pricing/changelog page | Template (`tpl-competitor-tracker`, fixed this session) | `schedule` node, cron `0 8 * * 1` | The fetched page object `{ status, url, text }` | Prose brief naming Suno specifically, keyed off `{{in.url}}` | Suede internal + external x402 caller | Per-agent x402 endpoint (see x402 revenue surfaces below) |
| DistroKid tracker | 1 agent instance, `web.fetchUrl.url` = DistroKid's pricing/changelog page | Template (same, separate instance) | Same cron | Same shape | Brief naming DistroKid | Same | Same |
| Audius tracker | 1 agent instance, `web.fetchUrl.url` = Audius's pricing/changelog page | Template (same, separate instance) | Same cron | Same shape | Brief naming Audius | Same | Same |
| Story Protocol tracker | 1 agent instance, `web.fetchUrl.url` = Story Protocol's pricing/changelog page | Template (same, separate instance) | Same cron | Same shape | Brief naming Story Protocol | Same | Same |
| Patchbay tracker | 1 agent instance, `web.fetchUrl.url` = Patchbay's pricing/changelog page | Template (same, separate instance) | Same cron | Same shape | Brief naming Patchbay | Same | Same |

**Why five separate instances, not one "roster" of five departments/employees under a company:** `schedule`'s params schema carries only `{ cron }`, an `input` node can't sit downstream of `schedule`, and a scheduled tick feeds the flow no runtime payload at all. The only place a competitor's URL can live is baked into the `web.fetchUrl` node's own `url` param, one URL per node, per instance. Multi-domain tracking in a single call would need a `loop`-based fetch, which is out of scope here and not built.

**A load-bearing wiring fact that changes which "roster" model applies:** `COMPANY_TEMPLATES` (the company/CEO system's template catalog) and `SEED_TEMPLATES` (where Competitor Tracker actually lives) are two separate arrays with **no import relationship** — a grep for "competitor" across `src/lib/company/templates.ts` returns zero matches. So today, there is no confirmed path to "hire" Competitor Tracker as a company employee through the CEO chat or the company template picker. The five rows above are five standalone agent launches, not five rows in a `company.departments[].employees[]` table. See "How to actually found this" below for what this means in practice.

## Org chart as a flow graph

Each of the five instances is the same 4-node linear graph (only the `llm` node's prompt text changed in this session's fix):

```
schedule ("0 8 * * 1")
   → web.fetchUrl (url: hardcoded per instance to one competitor's page)
        → llm (prompt interpolates {{in}} and {{in.url}}, produces a brief that names the specific competitor)
             → output
```

- **Trigger:** `schedule` node. No manual or webhook trigger is wired into this graph — the only confirmed entry point is the weekly cron tick (or a manual "Launch"/run-now action on the flow, a separate manual surface from the company `/fire` endpoint).
- **Hand-offs:** strictly linear, no fan-out, no branch nodes. `web.fetchUrl`'s output object `{ status, url, text }` is the entire payload the `llm` node sees; there is no conditional step that reacts to `status` (e.g., a failed fetch) — no error-branch or retry logic was found in this graph, so a failed fetch's downstream behavior is **not confirmed**.
- **Branch/halt rules:** none present in the graph as read. No delta-detection against last week's page state either — the `llm` node summarizes whatever the page says *right now*; it does not diff this week's fetch against last week's, so "what changed this week" is a claim the prompt asks the model to infer from the page's own current content, not a mechanically verified delta. This is a real limitation, not a documented feature.
- **Suede rails used:** the `web.fetchUrl` node type (added by a prior commit specifically to close this template's truth-in-advertising gap), the `llm` node, the `schedule` trigger, the `output` node, and — once launched via the generic flow-launch route — the platform's real hourly cron tick (`src/app/api/cron/tick/route.ts`) plus its shared `resolveRunMode()` dry/live gate.
- **Final output:** an unstructured prose brief per competitor per week, opening with the named competitor (per the fixed prompt) so a caller can never mistake which company a brief covers.

## Cron schedule

| Agent | Human-readable cadence | Time zone | Input window | Output destination | Human review |
|---|---|---|---|---|---|
| Suno tracker | Weekly, Monday 8:00 AM | UTC (the cron matcher in `src/lib/cron.ts` is UTC, minute-resolution) | Point-in-time fetch at trigger time only; no lookback/diff window | Run record, retrievable via the agent's run history/dashboard, and returned synchronously to any x402 caller who paid for that call | None confirmed by default — see caveats |
| DistroKid tracker | Same | Same | Same | Same | Same |
| Audius tracker | Same | Same | Same | Same | Same |
| Story Protocol tracker | Same | Same | Same | Same | Same |
| Patchbay tracker | Same | Same | Same | Same | Same |

Note: the platform tick itself is hourly, so sub-hourly schedules effectively round up to the tick. Not relevant to a weekly cron like this one, but worth knowing if the cadence is ever tightened.

## Per-endpoint pricing sheet

| Endpoint | Deliverable | Price per call (USDC) | Expected caller | Per-node run cost | Price status |
|---|---|---|---|---|---|
| Suno tracker | One dated brief naming Suno | 0.15 | Suede internal + external x402 caller | Not measured (fetch + one LLM call; no cost figure confirmed) | Configured, not yet live-collecting — `settlementLive: false` by default, requires the per-agent settlement toggle plus platform-wide `X402_SKIP_SETTLEMENT=false` |
| DistroKid tracker | One dated brief naming DistroKid | 0.15 | Same | Not measured | Same |
| Audius tracker | One dated brief naming Audius | 0.15 | Same | Not measured | Same |
| Story Protocol tracker | One dated brief naming Story Protocol | 0.15 | Same | Not measured | Same |
| Patchbay tracker | One dated brief naming Patchbay | 0.15 | Same | Not measured | Same |

## x402 revenue surfaces

| Endpoint | Caller sends | Caller receives | Price (USDC) | Business job | Discovery note | Rails used |
|---|---|---|---|---|---|---|
| Suno tracker | 0.15 USDC via x402 | A brief naming Suno, current as of that Monday's fetch | 0.15 | Keeps a standing read on Suno's pricing/feature/messaging moves | Per-agent discovery is served at `/api/agents/[agent]/.well-known/x402/route.ts`, returning `{ x402Version: 2, resource: { url, description, mimeType: "application/json", serviceName: "Suede Agent Studio", tags }, accepts: [{ scheme: "exact", network: "eip155:8453" (Base mainnet), amount, payTo (via resolvePayout), asset: USDC-on-Base contract address, maxTimeoutSeconds: 60 }], extensions: { bazaar: ... } }`. A root index at `/.well-known/x402/route.ts` lists every published endpoint site-wide. Confirmed by direct file inspection in this repo; re-verify against the live agent's own detail page once launched, since a live deployment can drift from the checked-out source. | `web.fetchUrl`, `llm`, `output`, x402 settlement path (`resolvePayout`), `resolveRunMode` |
| DistroKid tracker | 0.15 USDC | Brief naming DistroKid | 0.15 | Same, for DistroKid | Same | Same |
| Audius tracker | 0.15 USDC | Brief naming Audius | 0.15 | Same, for Audius | Same | Same |
| Story Protocol tracker | 0.15 USDC | Brief naming Story Protocol | 0.15 | Same, for Story Protocol | Same | Same |
| Patchbay tracker | 0.15 USDC | Brief naming Patchbay | 0.15 | Same, for Patchbay | Same | Same |

No take-rate math is included anywhere in this sheet — per a founder hold Jason placed on 2026-07-17 on all take-rate/percentage talk on public copy surfaces (`docs/copy/2026-06-11-platform-copy.md`), this document states only that `resolvePayout` routes every settled call straight to the creator's own connected wallet, without quantifying any split.

## How to actually found this (real steps in the current product)

This section follows the actual confirmed wiring, not the "company" framing's happy path, because a real mismatch exists between the two:

1. **Land the template fix first.** The `{{in.url}}`-naming fix to `tpl-competitor-tracker`'s prompt and the Sunday-night → Monday-8-AM copy fix are committed in this same change.
2. **Do not use the company-founding UI (`/founding` or the `TemplatePicker` on `/company`) for this.** `COMPANY_TEMPLATES` has no competitor-intelligence entry and no import relationship to `SEED_TEMPLATES` (where Competitor Tracker lives). Going through company founding would either produce an unrelated custom-generated manifest (via the guided LLM brain or its fallback) or, if you tried to attach this template to a company employee some other way, no code path was found anywhere that ever flips a company employee's schedule to `enabled: true` — it stays permanently disabled, so it would never be picked up by the hourly cron tick regardless of company status.
3. **Use the standalone template surface instead** — `/templates/competitor-tracker`, then the "Start building" CTA into `/start` or `/flows`. This matters specifically because `POST /api/flows/[id]/launch` is one of only two confirmed call sites in the whole codebase that sets `enabled: true` on a schedule (`src/app/api/flows/[id]/launch/route.ts:112`). Launching this way is the one confirmed route to a schedule the platform's real cron tick will actually execute.
4. **Create five separate instances**, one per competitor, each with the `web.fetchUrl` node's `url` param pointed at that competitor's pricing or changelog page (Suno, DistroKid, Audius, Story Protocol, Patchbay) — required because the node carries one URL only.
5. **Set price to 0.15 USDC per call** on each instance's agent record.
6. **Test in dry run before anything settles.** By default every new agent is created with `settlementLive: false`, and `resolveRunMode()`'s formula (`dryRun = requestedDryRun || !(globalLive && agentSettlementLive)`) means a run only ever settles real money if *both* the agent's own settlement flag *and* the platform-wide `X402_SKIP_SETTLEMENT` are explicitly set to live. Leave both alone and trigger a manual run (or let the Monday tick fire) to confirm each brief actually names the right competitor and reads the right page — zero USDC risk while doing this.
7. **Flip settlement live only when satisfied**, via `POST /api/agents/[agent]/settlement` per instance, and confirm that `X402_SKIP_SETTLEMENT` is `"false"` platform-wide — this is a platform-wide switch outside any single agent's control.
8. **Confirm x402 discovery directly on the live agent** at its own `.well-known/x402` route (see table above) before advertising the endpoint publicly, since deployed behavior can drift from checked-out source.
9. **On "autonomous":** once a schedule is `enabled: true` on a standalone-launched agent like this, the weekly tick runs it **without any human clicking "yes" each week** — that part of "autonomous" is real (`src/app/api/cron/tick/route.ts` runs every due, enabled schedule unattended, hourly resolution). What is **not** true, and must not be implied, is that this is managed by "an AI CEO" that hires/fires/rebudgets on its own: the confirm-gated CEO chat requires an explicit human "yes" for every hire, fire, or budget action, and — per point 2 above — this specific business isn't even wired into that company/CEO system today. The unattended part is the scheduled brief generation itself, not any autonomous business management.

## Launch checklist

- [x] Commit and merge the `tpl-competitor-tracker` prompt fix and the Monday-8-AM copy fix.
- [ ] Launch all five instances via `/templates/competitor-tracker` → `/start`/`/flows`, each with its own hardcoded competitor URL — not via `/founding` or the company `TemplatePicker`.
- [ ] Set 0.15 USDC price per instance.
- [ ] Leave `settlementLive: false` (the default) and run each instance manually at least once; confirm the brief opens by naming the correct competitor and that its claims trace back to the fetched page's own text.
- [ ] Confirm each instance's schedule shows `enabled: true` after Launch (easy to silently miss if the wrong founding path is used).
- [ ] Watch one full unattended Monday 8 AM tick in dry-run mode before turning on real settlement, to confirm the hourly cron tick actually picks up all five schedules as expected.
- [ ] Only after that dry run looks right: flip `settlementLive: true` per agent and confirm the platform-wide `X402_SKIP_SETTLEMENT=false` is set.
- [ ] Verify x402 discovery listing on the live agent directly (structure confirmed above; check the deployed agent's own detail page for drift).
- [ ] Do not describe this anywhere in public copy as run by "an AI CEO" or as fully autonomous company management — it is an unattended scheduled agent, not a company-system employee, per the wiring gap found above.

## Public-page pitch copy

**Headline:** Know what Suno, DistroKid, Audius, Story Protocol, and Patchbay changed this week.

**One-sentence result:** Every Monday at 8 AM, you get one short brief per competitor — pricing moves, feature shifts, and messaging changes drawn straight from that company's own pricing or changelog page.

**How it runs:** Each brief comes from a scheduled agent that fetches one competitor's page and asks a model to summarize what stands out for that company specifically — no digging, no tab-hopping, one page fetched fresh each week.

**Caller sends:** 0.15 USDC per call.

**Caller receives:** A dated, named brief for that one competitor.

**Price per call:** 0.15 USDC.

**Discovery path:** Listed on Suede Agent Studio's x402 agent directory (per-agent `.well-known/x402` route, plus the site-wide root index), callable directly once launched.

## Known gaps and caveats

1. **The competitor-list wiring gap that was just fixed.** Before this session, `tpl-competitor-tracker`'s `llm` node prompt referenced `{{in}}` generically ("a competitor page... summarize what stands out") without ever naming or scoping the brief to the specific URL configured on that node — so a brief for one competitor would read identically to a brief for a different one. The fix rewrote only the prompt to require the brief open by naming the specific competitor (from the page's own stated company name, or the domain in `{{in.url}}`) and to interpolate `{{in.url}}` directly.
2. **The Sunday-night/Monday-8-AM copy inconsistency.** The template's landing page CTA said the first brief "runs Sunday night," while the cron (`0 8 * * 1`), the page's own step-2 copy, its header, and its metadata description all independently agreed on "Monday." Three independent sources outvoting one confirmed the cron was correct and the CTA line was the bug; the CTA copy was corrected to say "Monday at 8 AM."
3. **What the company/CEO/autonomous-tick investigation could not confirm:** (a) no code path was found anywhere in `src/lib/company/*` or `src/app/api/companies/**` that ever flips a company employee's schedule to `enabled: true` — meaning a company employee with a schedule trigger cannot be picked up by the unattended cron tick through any company-scoped UI/API action found; (b) the cron tick applies **no company guardrails at all** — no budget check, no approval check, no paused/draft check — it is a flat, company-agnostic scheduler, relevant if this were ever wired into the company system later; (c) the exact per-node run cost was not measured and is marked "not confirmed" rather than invented.
4. **Claim-gate risk:** the CEO/hire-fire-rebudget feature shipped with **no dedicated copy-gate entry** in `docs/copy/` — there is no line saying what may or may not be claimed publicly about it. Its own engineering plan explicitly scopes "any autonomous/unattended execution" **out of scope**: every hire/fire/rebudget action requires an explicit human "yes" in the same chat thread. Because this specific business is not wired into that company system at all (see gap 3a), it must never be pitched as "run by an AI CEO" or as autonomously hiring/firing/managing anything. The only confirmed unattended behavior here is the scheduled brief generation itself, once launched through the standalone flow-launch path with its schedule enabled — that is real, but it is a different mechanism from "autonomous company management." Separately, per the platform-wide copy gates: no take-rate or percentage language is used (founder hold, 2026-07-17), no income/revenue promises are made, no free-tier claim is made, and no CLI/SDK/Relay claims appear anywhere in this document.
