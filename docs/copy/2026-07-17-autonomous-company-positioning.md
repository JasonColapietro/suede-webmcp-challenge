# Autonomous company positioning: founder lane

2026-07-17. Copy pack for the founder narrative: Suede Agent Studio as the way one
person builds an autonomous company that works while they sleep. Drafted by the Codex
fleet, review-gated, and claim-checked against the live landing page, /pricing,
/templates, /compare/gumloop-alternative, and the canonical copy deck ship gates
(`docs/copy/2026-06-11-platform-copy.md`).

Claim gates honored: no SDK install claims, no Relay claims, no income promises, no
invented metrics, and no take-rate math. **Founder hold (2026-07-17): take-rate talk
stays out of marketing copy until Jason lifts the hold**, even though the 5% take is
live in `src/lib/billing.ts` and rendered on /pricing. The gateway free tier (100k
tokens/month) is claimable. Still gated: "your first three live agents are free"
(no agent-count entitlement exists in code).

Machinery verified (2026-07-17): the production Vercel cron hits /api/cron/tick
hourly, and the tick runs every due schedule to completion unattended
(src/app/api/cron/tick/route.ts), so the overnight-run and while-you-sleep copy in
this pack matches shipped behavior. Scheduled runs settle live only when both the
platform and the agent have opted into live settlement; the dry-run framing in this
pack matches that rule.

Scheduler status (2026-07-17, updated): the production tick is paused — vercel.json
ships without a crons block. CRON_SECRET is now set on the Vercel project and the
tick route is verified end-to-end (an authorized manual POST returns 200), so
re-enabling is just restoring the crons block. The overnight-run social hook
stays locked until the scheduler is live and a real overnight run matches it.

## 1. Hero headline options

### V1: Build the company that works while you sleep

Wire the work on a canvas, set the schedule and price, then launch an x402 endpoint that other agents can discover and pay in USDC.

Rationale: Carries the core founder promise as a work claim, then names the complete operating and payment loop. The sleep claim is about work happening, never about income, so it stays inside the claim boundary.

### V2: Your next staff is a flow graph

The schedule starts the flow, the endpoint charges each caller, and x402 sends settled USDC on Base straight to your wallet.

Rationale: Makes the staffing idea tangible by showing exactly how the graph runs and gets paid.

### V3: Put your company on a schedule

Build specialized agents on the canvas, schedule recurring runs, set a per-call price, and publish them through .well-known x402 discovery.

Rationale: Centers the scheduling mechanism while carrying the reader from build to discovery.

### V4: One person can wire a whole company

Use real business templates as staff, watch runs stream in the dock, and launch callable services that can separately enable x402 payment.

Rationale: Frames leverage as visible, inspectable flows rather than a vague claim about autonomy.

### V5: A company that sells its work per call

Suede hosts the flow, meters every node, exposes the endpoint, and settles each paid call in USDC on Base.

Rationale: Leads with agent commerce and supports it with the hosting, metering, endpoint, and settlement machinery.

### V6: Fire yourself from operations

Wire the operations into a flow graph, put them on a schedule, and let launched agents take the work you used to do by hand.

Rationale: Bait register. Leads with the founder identity flip instead of the machinery; the subline immediately grounds it in the real mechanism.

## 2. The autonomous company

An autonomous company starts as a graph you can read. Open the canvas and give each part of the business a job. An input node receives the work. A specialized agent handles it. Logic nodes choose the next step. An output node returns the result. The company is visible as connected work, not buried in a stack of prompts.

Start with a real template or wire the flow yourself. Invoice Chaser handles overdue invoice follow-up. Lead Qualifier scores inbound leads. Competitor Tracker prepares a weekly brief. Review Responder drafts a specific reply. Meeting Prep Brief assembles context before a call. Each role is a flow you can inspect, test, and change on the canvas.

Then put the work on a schedule. Add a Schedule node and set the cadence in plain English. When the schedule fires, Suede runs the graph in topological order. The engine records a per-node USDC cost ledger and stops on an error branch. The run dock streams live progress over SSE, so you can see what happened at each node.

Next, price the work. You choose what a caller pays for a run. There is no merchant account and no manual invoice. Suede supplies the x402 payment rail, meters the model, and hosts the endpoint. You can dry-run the flow without a wallet or USDC before you let it accept paid calls.

When the flow is ready, launch it. The graph becomes a callable service and advertises whether it is previewable, payment-enabled, or unavailable. After its Live deployment, settlement gates, and payout are ready, another agent or developer can pay the advertised price in exact USDC and receive the result. The endpoint does not need you at the keyboard to take the request or complete the graph.

Launch also makes the agent machine-discoverable. Suede publishes it through the .well-known x402 discovery index, where other agents can find what it does and inspect its current state. Payment-enabled calls follow one path: find the endpoint, satisfy the x402 v2 payment, run the graph, return the work.

Settlement closes the loop for payment-enabled services. x402 settles exact USDC on Base and routes it to the configured wallet. The schedule can start recurring work while external callers use the endpoint according to its advertised state. You still decide what the company does, what each flow costs, and when it runs. The machinery keeps those decisions operating after you step away.

## 3. Your first staff

### Accounts receivable: Invoice Chaser

Invoice Chaser is your accounts receivable role. Its Monday schedule takes overdue invoice input and drafts the follow-up message. The schedule starts the flow, and the graph returns copy you can review or route onward.

### Inbound sales: Lead Qualifier

Lead Qualifier is your inbound sales role. The endpoint accepts a lead, scores it against your ICP, explains the score in plain English, and recommends the next action.

### Market analyst: Competitor Tracker

Competitor Tracker is your market analyst. Its Monday schedule runs the flow and returns a weekly brief covering pricing changes, feature launches, and messaging shifts.

### Support: Review Responder

Review Responder is your support role. Give the flow a customer review, and it returns a professional, specific response that addresses the review instead of producing a stock reply.

### Chief of staff: Meeting Prep Brief

Meeting Prep Brief is your chief of staff. Send the meeting input to its endpoint, and the flow returns a concise prep brief you can read before the conversation starts.

## 4. While you slept

At 7:00 a.m., you open the run dock. The overnight log is already there.

At 3:00 a.m., the schedule fired Invoice Chaser. The flow accepted the overdue invoice input, drafted the follow-up, and returned the result. Competitor Tracker followed its Monday schedule and produced a brief on pricing changes, feature launches, and messaging shifts.

A caller also found Lead Qualifier through the .well-known x402 index. The caller sent a lead, paid the $0.05 price you set, and triggered the endpoint. x402 settled the call in USDC on Base and routed the payment straight to your wallet. The graph scored the lead, explained the result, and recommended the next action.

Review Responder prepared a specific reply from review input. Meeting Prep Brief assembled context from meeting input. SSE streamed every run through the dock, and the per-node ledger showed what each graph cost and charged. You did not start those runs by hand. The schedules and paid endpoints did.

## 5. CTA options

### V1: Build your company graph

Rationale: Connects the founder goal directly to the visual canvas.

### V2: Launch your first staff

Rationale: Turns the staff metaphor into a concrete launch action.

### V3: Put work on schedule

Rationale: Leads with the scheduling mechanism that keeps flows running without manual starts.
