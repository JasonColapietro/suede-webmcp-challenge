# Product Marketing Context — 2026-07-28 snapshot

> Archived context, deliberately kept outside `.agents/`. It must not override
> current `AGENTS.md`, repository behavior, or live product evidence.

*Last updated: 2026-07-28*

## Product Overview

**One-liner:** Suede Agent Studio is the agent-company operating studio where the same agent can be managed as a company seat, inspected as a workflow, and published as a machine-callable service.

**What it does:** Founders, operators, and builders can describe a job in plain English, start from a template or website, refine the resulting flow on a visual canvas, save and promote immutable versions, and export the same flow to TypeScript. A qualified Live flow can be published with a public endpoint, machine-readable terms, a per-call USDC price, and x402 settlement on Base.

**Product category:** Primary shelf: AI agent builder and workflow automation. Ownable territory: agent-company operating studio, or Company as Software.

**Product type:** SaaS builder, public service directory, and pay-per-call distribution layer.

**Business model:** Building and launching are presented without a listing fee or monthly minimum. Published services can set a per-call USDC price, including zero. Current code sets the platform take to 0%, but that is a current implementation detail rather than a permanent pricing promise. Stripe currently funds an owner's gateway credits; it is not buyer checkout for individual agent calls.

## Target Audience

**Target companies:** Technical founders, small AI studios, productized-service firms, automation consultancies, independent developers, and operator-led businesses turning repeatable work into software.

**Decision-makers:** Founder, studio owner, technical operator, automation lead, product lead, and developer.

**Primary use case:** Turn repeatable work into an inspectable agent role that can be operated inside a governed company and, when ready, deployed as a callable service.

**Jobs to be done:**

- Define an agent company with a mission, departments, specialist roles, budgets, approvals, and books.
- Build a real workflow without losing the ability to inspect, test, version, or own its logic.
- Package repeatable work as a public service with schema, price, discovery terms, and settlement.
- Move from plain English to visual orchestration to TypeScript without rebuilding the same agent three times.

**Use cases:**

- Contract, document, spreadsheet, reporting, and invoice workflows.
- Lead qualification, call scoring, CRM handoff, outreach, content, and support workflows.
- Developer operations such as issue creation, workflow dispatch, release notes, and test-case drafting.
- Website-grounded FAQ, lead qualification, and brand-voice agents.
- Creator, music, rights, royalty, and promotion workflows as a differentiated vertical.
- Agent-company operations with departments, employee budgets, founder approvals, activity, and books.

## Personas

| Persona | Cares about | Challenge | Value we promise |
|---------|-------------|-----------|------------------|
| Technical founder | Leverage, clarity, ownership, a path to revenue | A pile of prompts and bots does not add up to an operating company | Make every role visible as a workflow and deployable as a service |
| Productized-service operator | Repeatability, margins, delivery quality | Client work stays trapped in human checklists and disconnected automations | Turn one proven workflow into a reusable, priced endpoint |
| Automation consultant | Fast delivery, inspection, client handoff | Visual tools can be easy to start but hard to govern or transfer | Start in Guided, refine in Studio, hand off code and exact versions |
| Developer | Contracts, portability, observability, APIs | No-code tools hide execution and agent frameworks require assembly | Use typed flows, version receipts, public APIs, TypeScript export, and machine discovery |
| Founder-operator | Budgets, approvals, risk, books | Autonomous-agent language hides who can change what or spend money | Keep organizational changes, effects, and Live promotion behind explicit control |
| Creator or rights operator | Repeatable creator operations and ownership | General automation platforms do not understand rights and royalty work | Use general business automation plus built-in creator, rights, and royalty rails |

## Problems & Pain Points

**Core problem:** Building an agent is easy. Turning several agents into a coherent, inspectable operating system that can safely deliver and sell work is not.

**Why alternatives fall short:**

- Prompt wrappers produce demos without an operating structure.
- Automation canvases wire tasks but do not naturally connect roles, company governance, and service economics.
- Multi-agent frameworks expose power but require developers to assemble UI, deployment, payments, and discovery.
- Agent marketplaces can list endpoints but do not necessarily help build, test, version, or govern the underlying work.
- Broad connector platforms win on integration count, while leaving the workflow-to-service business model as custom work.

**What it costs them:** Context rebuilding, duplicated logic, invisible failure states, unclear costs, brittle handoffs, slower client delivery, and repeatable work that never becomes a reusable asset.

**Emotional tension:** The operator can see what an agent-native company should become, but current tools leave them choosing between a toy, a black box, or an engineering project.

## Competitive Landscape

**Direct:** Gumloop, Relevance AI, Lindy, n8n, Make, Zapier, Flowise, Langflow, and similar agent or automation builders. Their strengths vary, especially connector breadth and maturity. Suede should not make blanket inferiority claims.

**Secondary:** CrewAI and code-first agent frameworks. They offer orchestration flexibility but require more assembly for company UX, visual editing, distribution, and payments.

**Indirect:** Prompts, custom scripts, internal SOPs, freelancers, and human-only productized services. They solve pieces of the job but do not create a single inspectable role-to-service system.

**Adjacent:** x402 marketplaces and paid-agent directories. They can help with discovery or settlement, but the payment rail alone does not create the workflow, company model, or governance layer.

## Differentiation

**Key differentiators:**

- The same agent is represented as a company seat, an inspectable flow, and a deployable service.
- Guided, Studio, and Code operate on the same persisted flow instead of separate artifacts.
- Company mission, departments, roles, budgets, approvals, activity, and books sit beside the actual employee workflows.
- Qualified flows can publish public run endpoints, agent cards, x402 terms, and per-call pricing.
- Dry-run, scoped testing, exact versions, Test-to-Live promotion, cost ledgers, and spend ceilings make control visible.
- Website-to-agent drafts from a bounded, robots-aware public crawl and shows sources before launch.
- TypeScript export, SDK source, CLI source, public APIs, and a relay path support ownership and portability.
- Creator and rights workflows sit inside a general business platform rather than defining the whole product.

**How we do it differently:** The product connects four layers that are usually separate: organization, execution, deployment, and economics.

**Why that is better:** A founder can reason about the business in company terms, inspect the work in workflow terms, govern changes in software terms, and distribute an approved capability in service terms.

**Why customers choose us:** They want more structure than a prompt, more ownership than a black box, and a shorter path from repeatable work to a callable service.

## Objections

| Objection | Response |
|-----------|----------|
| "Is this just another visual agent builder?" | The canvas is one layer. A flow can also be a company seat, an immutable Live version, and a public service with machine-readable terms. |
| "Does publishing guarantee revenue?" | No. Publishing makes a service available and discoverable. Revenue requires a settled paid call. Call counts are not the same as settled revenue. |
| "Can the agents all share memory and hand work to each other?" | Not as a general company-wide memory system today. Company employees share structure and governance. Subflows and loops provide bounded orchestration, but broad autonomous handoffs are not a current claim. |
| "Does it have every SaaS connector?" | No. Suede has focused nodes, encrypted API connections, webhooks, and a general HTTP path. Buyers who prioritize thousands of native connectors should compare directly. |
| "Is it enterprise certified?" | No. Suede does not currently claim SOC 2, HIPAA, or ISO 27001 certification. |
| "Can buyers pay an agent by card?" | Current per-call buyer settlement is x402-compatible USDC on Base. Stripe is currently used for owner gateway-credit top-ups. |

**Anti-persona:** Enterprises that require current formal compliance certifications, buyers whose first requirement is the largest native connector catalog, teams seeking a fully managed inbox assistant, or anyone expecting publication alone to generate demand.

## Switching Dynamics

**Push:** Disconnected bots, repeated setup, hidden execution, brittle handoffs, unclear spend, and valuable workflows trapped as internal labor.

**Pull:** One continuous role from company structure to visual flow to code to public service, with explicit versions, approvals, pricing, and receipts.

**Habit:** Existing SaaS subscriptions, familiar connector libraries, spreadsheets, prompt libraries, and the belief that an agent company requires a custom engineering team.

**Anxiety:** New payment rails, platform maturity, connector breadth, reliability, migration effort, and whether a public listing will create demand.

## Customer Language

**Working problem language:** These phrases are hypotheses inferred from the product and founder direction, not customer testimonials.

- "I do not need another bot. I need the work to fit together."
- "Show me what this agent actually does before it touches anything."
- "If the workflow works for me, I want to turn it into something clients or software can call."
- "I want to start in plain English without getting trapped in no-code."
- "I need roles, budgets, and approvals, not a bag of prompts."

**Working solution language:**

- "The same agent is a seat, a flow, and a paid endpoint."
- "Company as Software."
- "Build a company where every seat is a service."
- "Staff the company. Sell the work."
- "Describe it. Inspect it. Promote it. Publish it."

**Words to use:** seat, role, flow, service, inspectable, governed, version, promote, publish, settled call, receipt, endpoint, company, mission, budget, approval, books, Guided, Studio, Code.

**Words to avoid:** AI workforce, magic, fully autonomous, shared memory, revenue on every call, works while you sleep, production-grade, any rail, Stripe buyer payment, earning now, guaranteed demand, legal company formation.

**Glossary:**

| Term | Meaning |
|------|---------|
| Company | The mission, departments, roles, budgets, approvals, activity, and books layer |
| Seat | A specialist agent role inside a company |
| Flow | The inspectable execution graph behind an agent |
| Service | A deployed endpoint with an input contract and optional price |
| Receipt | Evidence of a version, run, cost, promotion, or settlement event |
| Guided | Plain-language flow creation and editing |
| Studio | Visual node-graph building and run inspection |
| Code | Generated or downloadable TypeScript view of the same flow |
| Dry-run | A no-payment test path where cost-bearing and effectful steps are stubbed |
| Live promotion | Explicit promotion of an immutable tested version into the Live environment |
| x402 | The HTTP payment protocol used for current per-call settlement |
| Call count | Public count of external agent-triggered calls, not a settled-revenue metric |

## Brand Voice

**Tone:** Confident, clear, ambitious, and candid.

**Style:** Operator-grade, proof-led, visually concrete, plain enough for founders, technical enough for builders.

**Personality:** Precise, inventive, owner-controlled, inspectable, and commercially minded.

## Proof Points

**Verified repository inventory at `origin/main` commit `4f2201d`:**

- 87 seeded workflow templates.
- 37 canonical node types across 10 palette groups.
- 8 agent-company starters covering 15 departments and 29 employee roles.
- 23 mapped Suede service endpoints.
- Guided, Studio, and Code navigation over the same persisted flow.
- Immutable versioning, scoped zero-cost tests, separate Test and Live promotion, and per-node cost ledgers.

**Verified live on 2026-07-28:**

- 29 priced services in the public catalog.
- 42 external machine-call events across those public counters. This is not proof of 42 paid or settled calls.
- x402 discovery version 2 with USDC on Base terms.
- The database, gateway, and facilitator dependency checks reported `ok` at the audit moment.
- Availability history returned no observations, so no uptime percentage is claimed.

**Customers:** No approved customer logos were found for this pack.

**Testimonials:** No approved customer testimonials were found for this pack.

**Value themes:**

| Theme | Proof |
|-------|-------|
| Company as Software | Company mission, departments, employees, budgets, approvals, activity, and books map to real agent flows |
| One agent, three control levels | Guided, Studio, and Code preserve the same underlying flow |
| Inspectable operations | Typed nodes, run receipts, cost ledger, immutable versions, and Test-to-Live promotion |
| Service packaging | Public run endpoint, agent card, x402 manifest, price, and discovery catalog |
| Safer adoption | Dry-run default, effect stubs, spend ceilings, explicit Live and settlement gates |
| Ownership | TypeScript export, SDK and CLI source, backups, and relay or self-host paths |

## Goals

**Business goal:** Establish Suede Agent Studio as the clearest way to build an agent-native company whose roles can become inspectable, governed, deployable services.

**Conversion action:** Build an agent company, with a secondary proof action to inspect a live endpoint.

**Current metrics:** Public catalog inventory and external call counters are visible. No verified funnel, customer, recurring revenue, or settled-only performance metrics were supplied for this pack.
