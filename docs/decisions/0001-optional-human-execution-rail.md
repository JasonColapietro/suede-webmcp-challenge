# ADR-1: Optional Human Execution Rail Through Suede Promo
Date: 2026-07-11
Status: Accepted

## Context

Suede Agent Studio is a Next.js 15 and React 19 visual agent builder backed by
TypeScript, SQLite or Postgres, a versioned flow contract, an execution engine,
and x402 agent-commerce rails. Its approved open-core overhaul is adding
production controls for versioned projects, typed graphs, durable execution,
connections, agent workforces, approvals, evaluations, and observability.

Suede Promo is a separate product and repository for human creator campaigns.
It owns campaign terms, creator participation, submitted proof, acceptance,
attribution, payout controls, rights-aware records, and human reputation. It can
give Agent Studio workflows access to authentic judgment, creative work,
distribution, and real-world action that software-only agents cannot reliably
provide.

The product principle is: **"Agents do the work. Humans make it matter."** The
architecture must add that option without removing or weakening agent-only
flows, replacing the current execution engine, or pausing the active open-core
overhaul. Real human use may inform evaluation, reputation, and discovery. The
platform must not manufacture engagement or misrepresent paid participation as
organic activity.

## Options

### Option A: Embed Promo capabilities and state inside Agent Studio

Move human sourcing, campaign state, submissions, proof, acceptance, disputes,
and payouts into the Agent Studio domain model and database.

Trade-offs: This gives one deployment and one local transaction boundary, but it
couples two active products, duplicates mature Promo responsibilities, expands
the Agent Studio migration surface, and makes independent product evolution
harder. It risks interrupting the current overhaul with a second large domain.

### Option B: Add Promo as an optional native human execution rail

Keep Agent Studio and Promo as separate bounded systems. Agent Studio exposes
optional human task and approval capabilities through a versioned adapter.
Promo remains authoritative for human identity, consent, campaign execution,
proof, acceptance, disputes, payout, attribution, and human reputation. Agent
Studio records stable external references and projects the status needed to
resume its workflow.

Trade-offs: This preserves ownership boundaries and lets both products evolve,
but requires an explicit cross-system contract, idempotency, retry behavior,
status synchronization, and failure containment. Cross-system reporting is more
work than a shared database join.

### Option C: Keep Agent Studio and Promo separate with manual handoffs

Link users between the products and let operators copy briefs, status, proof,
and payout information manually.

Trade-offs: This is cheap and highly reversible, and it preserves every current
system boundary. It does not create autonomous hybrid workflows, durable
agent-to-human handoffs, machine-readable status, or a compounding evaluation
and reputation loop.

## Decision

Choose Option B. Suede Promo becomes an optional native human execution rail
behind a versioned adapter contract. Agent Studio remains the orchestration and
policy owner. Promo remains the human campaign and proof owner. Agent-only,
human-approved, and hybrid workflows remain first-class options.

## Consequences

Enables: Workflows can commission named, reputation-bearing humans when
judgment, authentic distribution, creative identity, or real-world action is
required. Human outcomes can return as structured proof, artifacts, acceptance
state, and bounded reputation or evaluation signals. Promo can gain agent-driven
demand without becoming embedded in the Agent Studio runtime.

Forecloses: Agent Studio must not create a second human marketplace ledger or
silently treat humans as generic tool calls. Promo must not mutate Agent Studio
workflow state directly. Synthetic engagement and undisclosed paid activity are
outside the product direction.

Reversible if: The adapter remains versioned and all cross-system records use
stable external references. Promo can be disabled per workspace or deployment,
leaving agent-only workflows intact. Reversal cost is limited to retiring the
adapter and preserving historical references. Embedding Promo state later would
require an explicit migration and a superseding ADR.
