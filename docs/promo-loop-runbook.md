# Promo Loop runbook

How Suede Promo's campaign loop runs on Agent Studio: two flows, plus the review
queue at `/moderation/promo`.

**Start from the templates.** The creator campaign pack ships both flows, so
neither needs to be built by hand:

| Template | Covers |
|---|---|
| `campaign-launcher` | Flow 1 below — paid intake that opens a campaign |
| `campaign-watch` | Flow 2 below — scheduled read of the review queue |
| `creator-brief-writer` | Turns a rough launch note into a creator-ready brief |

Clone the template, set the price at publish time, and connect Slack for the
watch alert. The node-by-node tables below stay as the reference for what those
templates contain and for anyone modifying them.

Promo stays the system of record. These flows orchestrate through Promo's live
APIs and hold no campaign, claim, verdict, or payout state of their own. There
is no automated posting and no X write access anywhere in this design.

## Flow 1 — Promo Intake (paid)

An x402-priced endpoint that turns one paid call into a live Promo campaign.

| Step | Node type | Configuration |
|---|---|---|
| 1 | `input` | Fields: `name`, `brief`, `rewardUsdc`, `slotCap`, `hashtags` |
| 2 | `suede.promo` | Bind each param to the matching value from the input node's `result` output |
| 3 | `output` | Expose `campaign.campaignId` and `campaign.campaignUrl` |

Wire `input.result → suede.promo.in → output.in`.

Publish the flow as an agent. Pricing is set in the agent pricing control at
publish time, not in code. Payment is enforced by the published agent run route
(`src/app/api/agents/[agent]/run/route.ts`), which issues the x402 challenge,
verifies, and settles before the graph executes. A caller who has not paid gets
a 402 with the payment requirements and no campaign is created.

Attribution is automatic: the `suede.promo` node sends `sourceAgentId` and
`sourceFlowId` with every campaign, so Promo can trace any campaign back to the
run that created it.

## Flow 2 — Promo Watch

A scheduled read that surfaces claims automation could not decide.

| Step | Node type | Configuration |
|---|---|---|
| 1 | `schedule` | `cron: "*/10 * * * *"` |
| 2 | `suede.promoClaims` | `statuses: ["inconclusive", "disputed"]`, `limit: 200` |
| 3 | `branch` | Field `total`, truthy check — routes on whether any claims came back |
| 4 (true edge) | `comms.slackMessage` | `text`: `Promo review queue: {{claims.total}} claim(s) waiting — https://agents.suedeai.ai/moderation/promo` · `channel` optional |

Wire `schedule.result → suede.promoClaims.in → branch.in`, then
`branch.true → comms.slackMessage.in`. The false edge terminates: a quiet queue
sends nothing.

Requires the Slack connection configured under Studio connections. Promo's own
verification cron runs every 5 minutes, so a 10-minute watch interval never
lags the ledger by more than one verification cycle plus the watch interval.

## The review queue

`/moderation/promo` is the human tap. It is gated on the moderation reviewer
allowlist (`MODERATION_REVIEWER_EMAILS`); a non-reviewer gets a 404.

The page reads live claims through `/api/moderation/promo-claims`, which proxies
Promo's agent endpoints server-side so `PROMO_AGENT_KEY` never reaches a
browser. Each row shows the campaign, creator, proof link, failed checks, appeal
reason if the creator appealed, and the full evidence bundle.

Three decisions are available per claim: approve, reject, forfeit. Each writes
straight back to Promo, which applies the treasury movement and appends a
reputation event. If Promo has already resolved a claim another way (an appeal,
a re-verification), the write returns 409 and the queue refreshes — Promo's
record wins, always.

## Mirror discipline

- Promo is the system of record. Every fact on screen is read live from Promo.
- The flows never move money. Settlement is a pull model: creators withdraw
  approved claims themselves through Promo (`api/raid/withdraw.js`). Nothing in
  Agent Studio triggers a payout.
- Deleting both flows stops orchestration and alerting only. No campaign, claim,
  verdict, or payout is lost or altered.

## Operating it

- **Run history**: each intake call and each watch tick is a run under the
  owning flow, with inputs and node outputs recorded.
- **When the queue alert fires**: open `/moderation/promo`, work the rows,
  check the evidence bundle before deciding. Claims stuck in
  `verification_source_unavailable` are not review items — the X API was
  unreachable and Promo's cron will retry them on its own.
- **When intake fails after payment**: the run is marked failed with its
  settlement facts in the ledger. Promo's refund path covers brand escrow, not
  x402 intake revenue, so this case needs a manual refund decision. Rare, and
  it only happens when Promo's API is unreachable at execution time.
