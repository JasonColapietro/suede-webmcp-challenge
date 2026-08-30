# Suede Agent Studio Value Proposition System

> Historical strategy snapshot. Its positioning logic remains useful source
> material, but all facts and public recommendations are frozen at 2026-07-28
> and require current code and live evidence before reuse.

*Evidence freeze: 2026-07-28. Repository: `origin/main` at `4f2201d`. Live surface: `https://agents.suedeai.ai`.*

## Executive decision

The product is bigger than a visual builder and more coherent than a generic agent marketplace. Its strongest defensible idea is:

> The same agent is a seat, a flow, and a paid endpoint.

The recommended brand territory is **Company as Software**. The recommended category language is **the agent-company operating studio**.

The category is not "AI workforce." That phrase is crowded and implies shared memory, autonomous delegation, and unattended operation that Agent Studio should not claim today.

The mechanism is:

> Seat -> Flow -> Service -> Receipt

- **Seat:** Give the work a role, department, budget, and approval boundary.
- **Flow:** Open the role as typed, inspectable execution logic.
- **Service:** Promote an approved version and expose a public machine-callable boundary.
- **Receipt:** Record the version, run, cost, and any settled payment.

## Positioning statement

For technical founders and agent-native operators turning repeatable work into a business, Suede Agent Studio connects every company role to an inspectable workflow and every approved workflow to a deployable service, without separating the org chart, execution logic, and service economics into different products.

## Brand promise

> Every role is visible, governed, and deployable.

## Sharp tradeoff

Suede prioritizes inspectability, owner control, and workflow-to-service packaging over opaque autonomy, the largest connector catalog, or enterprise certification theater.

That tradeoff is a strength for the current ideal customer. It should be stated plainly.

## The value ladder

### Functional value

1. Describe a job in plain English.
2. Start from one of 87 workflow templates, 8 company starters, or a bounded website crawl.
3. Inspect and rewire the job on a real node canvas.
4. Save immutable versions and test bounded scopes without live effects.
5. Promote an exact version from Test to Live.
6. Publish the work as a public endpoint with machine-readable terms.
7. Price qualified services per call in USDC.
8. Track runs, costs, activity, books, and settlement receipts.
9. Export the flow to TypeScript and keep an owner-scoped backup.

### Operational value

- Replace disconnected agents with named roles and explicit organizational boundaries.
- Make the execution behind each role reviewable.
- Keep Draft, Test, and Live states distinct.
- Put budgets, cost ceilings, effects, and organizational changes behind control points.
- Use public APIs, manifests, and receipts instead of relying on a screenshot or prompt transcript.

### Commercial value

- Turn repeatable internal work into a reusable service boundary.
- Publish a price and payment terms alongside the capability.
- Make the service visible to humans and machine clients.
- Route a valid settled x402 call according to the configured payout hierarchy.
- Productize work without building a separate marketplace, billing protocol, and agent directory from scratch.

### Strategic value

- Model the business and the software as one connected system.
- Move from founder knowledge to repeatable workflow assets.
- Let nontechnical operators begin the work without blocking technical ownership later.
- Create a portfolio of services that can be inspected, improved, versioned, and distributed.

### Emotional value

- From "I have a pile of bots" to "I can see the company."
- From "I hope it does the right thing" to "I can open the flow and inspect the run."
- From "this lives in my head" to "this role has a contract, version, budget, and endpoint."
- From "no-code lock-in" to "I can move through Guided, Studio, and Code."
- From "this automation saves time" to "this workflow can become an owned service."

## Exhaustive value proposition map

| Value proposition | Human outcome | Product mechanism | Proof | Boundary |
|---|---|---|---|---|
| Company as Software | Think about an agent business in roles and departments | Company mission, org chart, employees, budgets, approvals, activity, books | `/company`; company routes and tests | This is an agent-company operating model, not legal entity formation |
| One role, one connected system | Avoid rebuilding the same agent in separate tools | Seat, flow, deployment, and service identity remain connected | Company UI links each employee to Studio and public state | No broad company-wide shared memory today |
| Plain-English start | Begin without knowing the canvas | Guided drafts and mutates a flow from one sentence | `/start`; Guided ownership tests | Model refinement can fall back to deterministic drafting |
| Visual inspection | See what the agent actually does | Typed node graph, ports, variables, bindings, run dock | `/build/new?template=contract-redflag-scan` | A visible graph does not by itself prove Live readiness |
| Code ownership | Hand the logic to an engineer or self-host path | Generated and downloadable TypeScript | `/code/<flowId>`; codegen tests | Code mode is generated flow logic, not arbitrary server-side code execution |
| One persisted flow across skill levels | Move between founder, operator, and developer views | Guided, Studio, and Code use the same owner-scoped flow | `PRODUCT.md`; mode switch and owned-flow tests | Code is disabled until a flow exists |
| Real orchestration | Build beyond one prompt | Branches, loops, typed subflows, HTTP, documents, data, comms, finance, developer, and Suede nodes | 37 canonical node types across 10 groups | Some nodes need external configuration or are stubbed in dry-run |
| Ready-made business jobs | Start from a real workflow instead of a blank canvas | 87 seeded templates with complete graphs and suggested prices | `/api/templates`; template source and tests | Suggested price is not proof of demand or profitability |
| Company starters | See a pre-staffed operating model | 8 templates, 15 departments, 29 employee roles | Company template source and `/company` | Starters are blueprints, not live businesses |
| Website-grounded drafting | Turn existing public knowledge into a bounded service draft | Robots-aware crawl, source review, extracted profile, price floor | `/from-website`; site-agent routes and tests | Reads the home page and up to five more public pages, not the whole web |
| Honest source boundary | Reduce invented claims | Agent can say the site does not specify an answer | Website-to-agent UI and grounding logic | Provenance marker is owner-editable, not tamper-proof |
| Safer experimentation | Try flows before money or effects move | Dry-run stubs cost-bearing and effectful steps | Public agent try-it; engine dry-run gates | Dry-run output is not proof of a provider-backed Live result |
| Scoped testing | Test a node or segment without executing the whole business | Node-only, run-to-node, and run-from-node tests | Ephemeral scoped-test architecture and tests | Requires exact boundary values and never resolves Live secrets |
| Exact promotion | Know what version is Live | Immutable versions, content hashes, Test-to-Live promotion | Version and deployment services and tests | A Test receipt proves selection, not external acceptance-test success |
| Cost visibility | See where a run spends money | Per-node USDC cost ledger and run ceiling | Engine, run detail, Studio cost ledger | Estimated or recorded costs are not a customer ROI metric |
| Governed organization changes | Keep the founder in control | CEO proposes hire, fire, department, and budget actions with confirmation | Company CEO and approval routes | Not a general autonomous manager-to-agent delegation loop |
| Encrypted API credentials | Keep secrets out of flow manifests | Owner-scoped encrypted Test and Live connection slots | Connection architecture and crypto tests | No broad OAuth or native connector marketplace |
| Public service packaging | Turn a workflow into a callable interface | Public run URL, input schema, public page, agent card | `/a/<slug>` and per-agent routes | Launch identity alone is not Live promotion |
| Machine discovery | Let software inspect what is available | JSON catalog, x402 index, OpenAPI, agent cards, A2A descriptor | `/api/catalog`, `/.well-known/x402`, `/openapi.json` | Discoverability does not prove indexing, selection, or demand |
| Per-call pricing | Attach economics to the service boundary | Suggested or chosen USDC price and x402 payment terms | Public catalog and x402 v2 manifest | Current buyer settlement is USDC on Base |
| Direct payout configuration | Route valid settled calls without a traditional checkout stack | Employee wallet, then owner wallet, with fallback handling | Billing and payout source | Do not say every call or every listing pays the creator |
| Free public dry-run | Let a buyer inspect the input and response path without a wallet | Dry-run on public agent pages | `/a/sales-call-scorecard-pulfa` | Dry-run calls are not paid calls |
| Portfolio and books | See activity as operating evidence | Run records, costs, activity, settlement ledger, company books | `/runs/<id>`; company activity and books routes | Public call counters are not settled-revenue counters |
| Recovery | Reduce fear of losing work | Session-scoped recovery, conflict handling, owner backup | Recovery and backup source and tests | Backup excludes run and agent history |
| Portability | Keep an exit path | TypeScript export, SDK and CLI source, template bundles, relay or local serving | Repository packages and docs | SDK npm publication and broad hosted portability are not claimed |
| Narrow durability | Retry and control eligible replay-safe work | Persisted events, reconnect, pause, cancel, resume, retry | v3 durable runtime source and tests | Current durable lane is narrow, local or self-hosted, and not HA |
| Creator and rights depth | Automate specialist IP and creator workflows without changing platforms | Music, rights, royalty, and promotion nodes | Music and IP palette group and mapped services | This is a vertical inside a general platform |
| Anonymous first use | Lower the barrier to building | Anonymous workspace path with optional sign-in | Live Guided and Studio journeys | Long-term ownership and account recovery still benefit from identity |
| Mobile-safe creation path | Keep creation usable on small screens | Mobile directs users to Guided while Studio remains desktop-first | Live mobile guard | The iOS shell is not a separate native feature implementation |

## Message house

### Roof: Company as Software

Build an operating company where every role is visible as a workflow and shippable as a service.

### Pillar 1: Operate as a company

**Promise:** Give agent work a mission, role, department, budget, and approval boundary.

**Proof:**

- 8 company starters.
- 15 pre-modeled departments.
- 29 specialist employee roles.
- Founder-confirmed organizational changes.
- Activity and books based on recorded system events.

### Pillar 2: Inspect every role

**Promise:** Open a seat and see the logic behind it.

**Proof:**

- Guided, Studio, and Code over one persisted flow.
- 37 typed node types across 10 groups.
- Variables, typed ports, branches, loops, and reusable subflows.
- Run log, cost ledger, and version history in the build surface.

### Pillar 3: Govern the move to Live

**Promise:** Separate drafting from testing and testing from deployment.

**Proof:**

- Dry-run default.
- Scoped zero-cost tests.
- Immutable saved versions.
- Exact Test-to-Live promotion.
- Per-run spend ceiling.
- Explicit confirmation for sensitive organizational changes.

### Pillar 4: Ship a role as a service

**Promise:** Give approved work a public machine-callable boundary.

**Proof:**

- Public run endpoint.
- Agent card and input contract.
- x402 v2 payment terms.
- Human directory and JSON catalog.
- Price, payout configuration, and settled-call ledger.

## Audience-specific value propositions

### Technical founder

**Before:** Every agent is a separate experiment.
**After:** The company, workflow, service, and economics are one visible system.
**Lead:** Build a company where every seat is a service.
**Proof:** Company chart, Studio flow, endpoint, and receipt shown in one sequence.
**CTA:** Build an agent company.

### Productized-service operator

**Before:** The service depends on manual delivery and founder judgment.
**After:** The repeatable part has a versioned workflow and callable boundary.
**Lead:** Turn repeatable work into paid agent services.
**Proof:** Template -> customized flow -> public endpoint -> per-call terms.
**CTA:** Productize one workflow.

### Automation consultant

**Before:** Client automations are hard to explain, govern, and hand off.
**After:** The client can see the job, graph, version, run, and service terms.
**Lead:** Deliver the workflow and the operating model.
**Proof:** Guided discovery, Studio inspection, Code export, backup.
**CTA:** Build from a client job.

### Developer

**Before:** Framework code still needs UI, deployment, discovery, payments, and operating controls.
**After:** The flow already has public contracts, promotion rules, and a service boundary.
**Lead:** Go from typed graph to payable API without assembling five products.
**Proof:** OpenAPI, agent card, x402 manifest, run route, TypeScript export.
**CTA:** Inspect a live endpoint.

### Creator or rights operator

**Before:** General automation ignores the data and proofs creator work needs.
**After:** Rights, royalty, and promotion operations fit inside the same company and service system.
**Lead:** Build the creator business and the agents that operate it.
**Proof:** Music and IP nodes, rights lookup, royalty split, promotion routes.
**CTA:** Start from a creator workflow.

## Competitive framing

### What Suede can own

- The same agent is a seat, a flow, and a paid endpoint.
- Company budgets, approvals, and books connected to deployable services.
- Guided, Studio, and Code as one continuous build.
- Workflow-to-service packaging with machine-readable payment terms.
- General business automation with unusually deep creator and rights rails.

### What Suede should concede

- Earlier than incumbent automation platforms in native connector breadth.
- Earlier than mature multi-agent platforms in shared memory, handoffs, and observability.
- Earlier than enterprise platforms in certifications, SSO, RBAC depth, audit exports, and procurement readiness.
- x402 settlement currently means a compatible buyer paying USDC on Base.
- Publishing creates availability, not customers.

### Swap test

If a competitor can say the line without changing a word, cut it.

| Phrase | Result |
|---|---|
| Build powerful AI agents | Fails |
| Your AI workforce | Fails |
| Automate your business | Fails |
| Agents that earn | Partial |
| The same agent is a seat, a flow, and a paid endpoint | Strong |
| Build a company where every seat is a service | Strong |
| Company budgets, approvals, and books connected to real agent workflows | Strong |

## Claims ledger

### Safe now

| Claim | Evidence | Review rule |
|---|---|---|
| Guided, Studio, and Code are three views of the same persisted flow | Product rules, mode switch, ownership tests | Recheck after data-model changes |
| 87 workflow templates | Executed import of `SEED_TEMPLATES`; live template API | Render from data in product copy |
| 37 canonical node types across 10 groups | Executed import of `NODE_DEFINITIONS` and `NODE_GROUP_ORDER` | Render from data in product copy |
| 8 company starters, 15 departments, 29 roles | Executed import of `COMPANY_TEMPLATES` | Recheck when templates change |
| 23 mapped Suede service endpoints | Executed import of `SUEDE_ENDPOINTS` | Say mapped, not all independently proven Live |
| 29 priced services in the public catalog | Live `/api/catalog` on 2026-07-28 | Timestamp the count |
| 42 external machine-call events in public counters | Live catalog sum on 2026-07-28 | Never label as paid calls or revenue |
| x402 discovery version 2 with USDC on Base terms | Live `/.well-known/x402` | Recheck network and asset before campaigns |
| Dependency checks reported ok at audit moment | Live `/status.json` | Do not convert to an uptime claim |

### Use with an exact qualifier

| Claim | Exact qualifier |
|---|---|
| Get paid per call | Get paid on each valid settled x402 call routed to the configured payout destination |
| Launch an agent | Launch creates its public service identity; paid execution still requires exact Live and settlement gates |
| Run safely | Dry-run stubs external or cost-bearing effects; Live behavior requires separate verification |
| Durable runs | A narrow local or self-hosted lane supports eligible replay-safe zero-budget graphs |
| Connections | Encrypted static API credential slots for qualified Live execution, not broad OAuth connector parity |
| Own the code | Export generated TypeScript and use the repository SDK or relay paths; npm publication is not claimed |
| Website grounded | Reads the home page and up to five more public pages, shows sources, and defaults to unlisted until domain verification |

### Do not claim yet

- Revenue on every call.
- Earning now based on a call counter.
- Shared company memory.
- Autonomous cross-agent delegation.
- Works 24/7 or while you sleep without current scheduler proof.
- Buyer card payment through Stripe.
- x402, Stripe, A2A, ACP, and other technologies as equivalent settlement rails.
- Any-chain settlement.
- Every flow can be published.
- Production-grade, enterprise-grade, SOC 2, HIPAA, or ISO 27001.
- Thousands of native connectors.
- Guaranteed discovery, demand, earnings, or ROI.
- Full hosted high-availability durable execution.
- SDK availability on npm without separate verification.

## Proof sequence for the website and sales demos

Use one continuous story instead of a feature wall:

1. **Company:** Show mission, departments, roles, budgets, approvals, and books.
2. **Seat:** Open one employee role.
3. **Flow:** Reveal the typed workflow behind that role.
4. **Control:** Show dry-run, cost ledger, immutable version, Test, and Live.
5. **Service:** Show the public agent page, input, endpoint, price, and discovery documents.
6. **Receipt:** Show a real run receipt and, only when available, separate settled-payment evidence.

## Homepage information architecture

The current homepage is too long and repeats the product through too many metaphors. Compress it to:

1. Hero: category, mechanism, primary CTA, one proof CTA.
2. The connected object: `Seat -> Flow -> Service -> Receipt`.
3. Company proof: org chart, budgets, approvals, books.
4. Workflow proof: actual Studio screenshot and Guided/Studio/Code.
5. Service proof: actual public endpoint page and machine-readable terms.
6. Safety and ownership: dry-run, versions, promotion, spend, export.
7. Use cases and starter inventory.
8. Honest fit and tradeoffs.
9. Final CTA.

## Microscope findings: marketability debt

These findings weaken trust or obscure the core value even when the underlying capability is strong.

| Priority | Finding | Why it matters | Recommended correction |
|---|---|---|---|
| P0 | The homepage says "Revenue on every call" while public counters include external machine calls, not settled-only revenue | Conflates usage with payment | Use "Get paid on every valid settled call" and maintain a separate settled counter |
| P0 | Current copy presents Stripe beside x402 as a buyer payment path | Stripe currently funds owner gateway credits | Change buyer-payment copy to x402-compatible USDC on Base; describe Stripe only as gateway-credit funding |
| P0 | Current copy implies shared context across agent employees | Company structure and governance exist, but general shared organizational memory does not | Say "shared mission, structure, and governance" |
| P0 | Current copy includes 24/7, works-while-you-sleep, and broad unattended-operation language | A scheduler route is not current production scheduler proof | Use scheduled or unattended language only after a verified configured scheduler and run history |
| P0 | Pricing says both "100%" routes to the wallet and later "the majority" | A direct contradiction on money damages trust | Align every page with the exact current payout policy and its fallback hierarchy |
| P0 | Agentix displays a seeded example portfolio with large earnings and call figures | The visually persuasive demo could be mistaken for Studio performance evidence | Keep a persistent "Example data" label and never reuse the figures as proof |
| P1 | The homepage contains 18 H2 sections and measured about 12,031 desktop pixels, 22,211 mobile pixels | The connected `Seat -> Flow -> Service -> Receipt` story is buried in repetition | Compress to the nine-section information architecture above |
| P1 | Launch Pad says 6 agents live while the directory presents 24 of 29 in its current state | Inventory disagreement creates product doubt | Drive all public counts from the same fresh membership query |
| P1 | The mobile menu clips the beginning of labels at a 390-pixel viewport | A primary navigation failure blocks product discovery | Fix the off-canvas panel origin and add 390-pixel visual regression coverage |
| P1 | Code is disabled on a new flow without explaining the prerequisite | Users can read the disabled state as a missing feature | Add a tooltip: "Create or save a flow to open its TypeScript" |
| P1 | The public homepage still cites 34 node types while the current canonical registry contains 37 | A small proof inconsistency undermines confidence in larger claims | Render the count from the canonical registry |
| P2 | The blank Studio exposes many controls before the user has a working graph | The product feels heavier than the Guided promise | Default first-time users to a real job, website draft, or prewired template |
| P2 | Docs, dashboard, and homepage each combine several distinct journeys | Users have to distinguish building, operating, funding, publishing, and recovery at once | Give each page one primary job and one primary CTA |

## Measurement plan

Prioritize product milestones over traffic vanity:

1. Qualified company created.
2. First employee flow opened.
3. First successful dry-run.
4. First immutable version saved.
5. First Test promotion.
6. First Live promotion.
7. First endpoint published.
8. First external machine call.
9. First valid settled paid call.
10. Thirty-day active companies with at least one repeated successful service run.

Keep `callCount` and `settledCount` separate in product analytics and public copy.

## Proof needed for the next, stronger story

- One public end-to-end demo from company creation through a real settled call and books entry.
- A company context object inherited by every employee.
- Traceable cross-agent handoff artifacts.
- Settled-only usage and revenue metrics.
- Verified unattended scheduler history.
- Buyer card checkout before mentioning card payment.
- Approved customer examples and testimonials.
- Security audit, SSO, audit export, and procurement proof before enterprise claims.

## Source map

### Live

- `https://agents.suedeai.ai/`
- `https://agents.suedeai.ai/start`
- `https://agents.suedeai.ai/company`
- `https://agents.suedeai.ai/build/new?template=contract-redflag-scan`
- `https://agents.suedeai.ai/from-website`
- `https://agents.suedeai.ai/a/sales-call-scorecard-pulfa`
- `https://agents.suedeai.ai/api/catalog`
- `https://agents.suedeai.ai/api/templates`
- `https://agents.suedeai.ai/.well-known/x402`
- `https://agents.suedeai.ai/status.json`

### Repository

- `AGENTS.md`
- `PRODUCT.md`
- `README.md`
- `src/app/page.tsx`
- `src/app/company/page.tsx`
- `src/app/from-website/page.tsx`
- `src/app/a/[slug]/page.tsx`
- `src/app/fit/page.tsx`
- `src/app/security/page.tsx`
- `src/components/mode-switch.tsx`
- `src/lib/templates.ts`
- `src/lib/company/templates.ts`
- `src/lib/flow/node-definitions.ts`
- `src/lib/flow/engine.ts`
- `src/lib/billing.ts`
- `src/lib/payout.ts`
- `src/lib/catalog.ts`
- `src/lib/rails/suede-endpoints.ts`
- `docs/architecture/ephemeral-scoped-tests.md`
- `docs/architecture/version-restore-promotion.md`
- `docs/architecture/durable-runtime.md`
- `docs/architecture/local-connections.md`
- `docs/architecture/portable-operation-kernel.md`
