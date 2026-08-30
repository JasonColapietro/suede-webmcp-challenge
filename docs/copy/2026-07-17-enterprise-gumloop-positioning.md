# Enterprise Gumloop positioning pack

2026-07-17. Copy pack for the enterprise narrative: Suede Agent Studio as the
enterprise Gumloop. Automation a business team can read, plus the commerce, metering,
discovery, and rights layers Gumloop-class tools do not carry. Drafted by the Codex
fleet, review-gated, and claim-checked against the live landing page, /pricing,
/compare/gumloop-alternative, and the canonical copy deck ship gates. Capability
comparisons state presence only; nothing here disparages a competitor or invents a
customer, logo, or number.

Claim-gate update (2026-07-17): **founder hold on take-rate math. Take-rate talk
stays out of marketing copy until Jason lifts the hold**, even though the 5% take is
live in `src/lib/billing.ts` and rendered on /pricing. The gateway free tier (100k
tokens/month) is claimable. Still gated: "first three live agents are free" (no
agent-count entitlement in code). Nothing in this pack uses take math; keep it that
way in any derivative copy.

## The enterprise Gumloop narrative

### V1

*Rationale: Lead with a familiar visual automation category, then make the commerce and ownership machinery concrete.*

Gumloop-class tools give a business team visual automation it can read. Operators can follow the steps, understand how data moves, and discuss the workflow without translating a wall of code. Suede Agent Studio starts with that same useful premise. You wire specialized agents on a node-graph canvas, see the path from trigger to output, and watch a run stream through the run dock over SSE.

Agent Studio goes further because the workflow is not only an internal automation. In Agent Studio, a published workflow becomes machine-discoverable and reports preview, payment-enabled, or unavailable. You set a per-call price; once its payment gates, Live deployment, and payout are ready, x402 v2 settles exact USDC on Base. The workflow can also run on its own through built-in scheduling via a Schedule node. That gives your team one readable system for recurring internal work and public services whose call availability is explicit.

The execution engine makes the economics visible inside the graph. Every node is cost-metered through a per-node USDC cost ledger. Your team can see what a run costs and what the endpoint charges, instead of separating workflow design from transaction data. Dry-run testing requires no wallet and no USDC, so operators can evaluate the graph before enabling live settlement. When the workflow is ready, the payment behavior changes without a code rewrite.

Agent-to-agent commerce is built into the same system without pretending that every published service accepts payment. A published workflow appears through the `.well-known` x402 discovery index with an explicit preview, payment-enabled, or unavailable state. A2A 1.0 and the AgentCard provide agent-facing interfaces; x402 v2 is the distinct caller-settlement protocol. Only a payment-enabled service advertises x402 terms and settles exact USDC on Base. No separate merchant account or manual invoicing sits between the caller and that endpoint.

Ownership tools can be part of the workflow architecture rather than a separate policy document. Teams can add the available IP registry and royalty-routing nodes where the work actually needs them; those capabilities are not automatic attributes of every flow. Gumloop-class automation makes workflows legible. Suede Agent Studio keeps that legibility and adds metered costs, machine discovery, optional caller payments, and programmable rights tools in the same graph.

## Capability comparison

| Capability | Gumloop-class automation tools | Suede Agent Studio |
| --- | --- | --- |
| Visual canvas builder | Visual drag-and-drop workflow builder | Visual node-graph canvas builder |
| Scheduling | Scheduling mechanism not verified for this pack | Built-in scheduling via a Schedule node |
| Per-node cost metering | Per-node cost mechanism not verified for this pack | Per-node USDC cost ledger |
| Workflow as billable endpoint | Callable workflows without native per-call monetization stated | Published flows advertise call state; ready services can separately enable x402 v2 payment |
| Agent-to-agent payments | No on-chain payment layer stated | Payment-enabled calls settle through x402 v2 in USDC on Base |
| Machine discovery of workflows | Workflows are private by default | `.well-known` x402 discovery index with explicit public call state |
| IP and rights tools | IP and rights mechanism not verified for this pack | Optional IP registry and royalty-routing nodes |
| Dry-run before real spend | No equivalent dry-run mechanism verified for this pack | Internal testing requires no wallet; ordinary published agents can advertise preview |

## Enterprise buyer objections

### Security

**Objection:** We do not want evaluation to require a wallet or live funds.

**Answer:** Internal dry-run testing requires no wallet and no USDC. Ordinary published agents can also advertise preview; company services advertise unavailable instead of exposing a public dry-run until their paid-call gates pass. Your team can build and test before enabling x402 settlement, which separates evaluation from live payment activity.

### Spend control

**Objection:** How do we see what a workflow costs before it becomes an open-ended expense?

**Answer:** The execution engine records a per-node USDC cost ledger. You can inspect the cost of each node and compare the run cost with the per-call price set on the endpoint.

### Auditability

**Objection:** How can an operator see what happened during a run?

**Answer:** Runs stream live over SSE into the run dock, while the per-node USDC cost ledger records costs across the graph. The workflow remains visible on the canvas from trigger to output.

### Lock-in

**Objection:** What happens if we need direct ownership of the implementation?

**Answer:** The same agent can be exported as TypeScript at `/code/[flowId]`. Your team can move from the visual canvas to owned code while keeping the workflow logic in a form developers can inspect.

### Why now

**Objection:** Why add a commerce layer to automation now?

**Answer:** The `.well-known` x402 discovery index lets other agents find published workflows and inspect their current public call state. When a service is payment-enabled, x402 v2 settles its paid calls in USDC on Base. Those mechanisms let an eligible workflow serve machine buyers directly instead of remaining only an internal automation.

## Copy upgrade for `/compare/gumloop-alternative`

### Hero option, V1

*Rationale: Preserve the live earning-agent promise while making the enterprise commerce layer explicit.*

**Headline:** The Gumloop alternative built for earning agents

**Supporting line:** Give your team visual automation it can read, publish each workflow with an explicit call state, and separately enable eligible services for x402 v2 caller payments in USDC on Base. Machine discovery is built in; IP registry and royalty-routing tools are available when a workflow needs them.

### Section rewrite 1: Agents that pay you back

**Headline:** Turn each workflow into a billable endpoint

Build on a visual canvas, set a price per call, and launch. Another agent or developer can call the service according to its advertised state; when payment is enabled and ready, x402 v2 settles exact USDC on Base. The per-node USDC cost ledger shows what the run costs and what the endpoint charges.

### Section rewrite 2: Built for agent-to-agent commerce

**Headline:** Make your workflows discoverable to other agents

Publishing creates more than a webhook. The `.well-known` x402 discovery index lets other agents find the workflow and inspect whether it is preview-ready, payment-enabled, or unavailable. A2A 1.0 and the AgentCard describe the agent-facing interface. Only payment-enabled services publish x402 terms; IP registry and royalty-routing nodes remain optional workflow tools.

### Section rewrite 3: Dry-run first

**Headline:** Prove the workflow before it touches a wallet

Build and test in dry-run with no wallet and no USDC. An ordinary published service can advertise preview; a company service advertises unavailable until its paid-call gates pass. Watch execution stream through the run dock, inspect the graph, and review the per-node cost ledger. When the workflow is ready, enable live USDC settlement without changing its code.
