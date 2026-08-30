# Resource Foundry operating contract

Resource Foundry turns owner-selected material into a reviewed, immutable
Resource Pack that performs one narrow job. It reuses Agent Studio's existing
Company, Agent, Flow, Version, Deployment, Run, Receipt, discovery, and payment
rails; it does not introduce a second public execution engine.

This document describes the implemented local contract. It is not evidence
that the prepared PostgreSQL migration has been applied or that Resource
Foundry is deployed in production.

## Owner path

1. Open `/resources/new`, name the resource, choose public or unlisted
   discovery, and choose free, paid, or private execution.
2. Add manual text or JSON rows, or collect a public URL through the existing
   bounded crawl boundary. Anonymous and new owners can use the manual-first
   path; provenance may be omitted.
3. Review the proposed record schema, explicit filter and return fields,
   taxonomy, records, evidence, unknowns, conflicts, freshness, and Job
   Contract.
4. Approve the current candidate. Approval creates an immutable Resource Pack
   version; approved, Live, and retired pack content cannot be edited in place.
5. Test the exact approved pack. The dry-run returns its version, semantic
   hash, freshness, evidence, unknowns, conflicts, and output-schema result.
6. Publish through the ordinary Test-to-Live agent rails. Publication pins one
   Flow version, graph hashes, deployment and environment, agent, owner,
   Resource Product, Resource Pack version and semantic hash, access policy,
   and fixed per-call price.

Publication is always explicit. Collection, approval, testing, refresh, and
site import never auto-promote a draft or candidate.

This release does not provide a file adapter for PDF, DOCX, CSV, spreadsheet,
or general file upload. Those formats must not be represented as supported
intake until a bounded, tested parser exists. Current supported intake is
manual text, JSON rows, and bounded public URL/site collection only.

## Resource Pack lifecycle

```text
owner-selected source
  -> immutable source snapshot
  -> editable candidate pack
  -> approved immutable pack
  -> exact tested Flow version
  -> immutable Live deployment and Resource release
  -> version-pinned run receipt
  -> reviewed refresh candidate
```

Refreshing creates new snapshots and a candidate diff. It reports record,
schema, taxonomy, evidence, and freshness changes without changing the current
Live release. The owner may reject the candidate, leave it pending, or approve
and explicitly republish a new exact version.

## Job Contract

Every Resource Product exposes one reviewed contract:

- job statement and buyer intent;
- strict input and output JSON Schemas;
- unsupported-request behavior;
- evidence requirement;
- safe synthetic example;
- review boundary; and
- data-handling disclosure.

The materialized graph is deliberately small: input -> `resource.query` ->
output. It is not a generic chat, LLM, or vector-search wrapper. The graph
stores only server-derived Resource Product, pack-version, and semantic-hash
pins plus explicit filter and return fields. Callers cannot supply or override
dependency pins.

## Query semantics

`resource.query` resolves the exact owner-approved Product, pack version, and
semantic hash. A missing, superseded, mismatched, malformed, or forged pin
refuses execution. Filters must exactly match the declared filter fields, and
only declared return fields can appear in results.

The request boundary is deterministic and bounded:

- at most 100 returned records;
- identifiers of at most 128 UTF-8 bytes;
- at most 64 filter or return fields;
- at most 64 KiB and 2,000 values in filters; and
- at most 16 nested JSON levels.

Objects with accessors, symbols, hostile prototypes, duplicate normalized
keys, non-finite numbers, extra contract keys, or prototype-pollution keys are
rejected. Supported fields carry evidence pointers. Missing fields and source
disagreements remain explicit in `unknowns` and `conflicts`; the runtime does
not invent a plausible answer.

Durable runtime policy version 9 refuses `resource.query`. Resource-backed
execution instead uses the ordinary published-run path, which prepares one
exact immutable Live authority for validation, dry-run, 402 challenge, paid
execution, AP2, and receipt persistence. Relay execution is intentionally
unsupported for Resource agents: relay registration refuses before an
endpoint is stored, and a legacy relay row fails closed before payment.

## Public and buyer contract

Public service pages, catalog entries, root and per-agent Agent Cards, A2A,
MCP, OpenAPI, x402, `llms.txt`, and service discovery project the same approved
Job Contract and exact Resource release. They never fall back to a mutable
Draft graph.

- `public` discovery appears in aggregate catalog and discovery surfaces.
- `unlisted` discovery stays out of aggregate catalog and indexing but remains
  available through its exact direct agent URL.
- `private` execution returns the same opaque not-found response as a missing
  agent before request parsing, payment, relay, or execution.
- `free` execution uses the same prepared release without a payment challenge.
- `paid` execution advertises x402 terms only when the existing payment
  readiness and settlement authorization controls say the release is ready.

The aggregate public source disclosure contains only source count and source
kinds from the reviewed immutable release. It contains no source locator,
snapshot body, normalized record, evidence body, credential, private example,
or provenance note.

HTTP, MCP, and A2A return the same logical envelope:

```json
{
  "result": [],
  "resourceReceipt": {
    "resourceProductId": "resource_...",
    "resourceVersion": "pack_...",
    "semanticHash": "sha256...",
    "freshness": "fresh",
    "evidence": [],
    "unknowns": [],
    "conflicts": [],
    "outputSchemaValid": true
  },
  "payment": {
    "state": "free",
    "priceUsdc": 0
  }
}
```

The persisted Resource Run Receipt additionally binds the run, agent, Flow
version, deployment, payment identifier and state, and advertised price. A
run ID can produce only one exact receipt; replay with a changed identity,
pack, evidence set, price, or payment state fails closed.

After a completed paid AP2 run, recovery rebuilds and persists that exact
canonical Resource envelope from the immutable release plus durable run and
payment facts. Receipt-write and terminal-transition retries are idempotent;
they do not execute or settle again. An ordinary x402 post-settlement failure
returns a no-store manual-reconciliation response containing the durable run
and transaction identifiers. It does not guess a legacy response or
automatically retry fulfillment after money moved.

## Privacy, source context, and access

Raw sources, snapshots, normalized records, private examples, credentials, and
provenance notes are private owner data. Public discovery is assembled from a
credential-redacted, deeply frozen immutable Live graph, not from mutable
repository rows.

Source provenance is optional owner-supplied context:
`mine`, `licensed_or_permissioned`, `public_source`, or
`other_or_unspecified`. Suede does not verify those labels. Missing provenance
does not block creation, approval, free or paid publication, discovery, or
execution. There is no evidence-upload step, verification queue, external
ownership check, or provenance-based publication predicate. Existing reactive
legal, privacy, security, abuse, and takedown controls remain available.

## Operational controls and honest measurement

`RESOURCE_FOUNDRY_ENABLED` is enabled unless its exact value is `0`. That is
the only Foundry-specific emergency stop. There are no entitlement or
subfeature controls, and anonymous creation and testing remain available.

Paid execution retains Agent Studio's existing global settlement controls,
wallet/payout readiness, x402 payment verification, AP2 authorization and
replay protections, and reconciliation evidence. Resource Foundry adds no
buyer-side spending, dynamic pricing, autonomous purchasing, or settlement
enablement. A real settlement test remains a separately authorized operation.

Trust & Earnings reports only durable receipt facts. Attempted, challenged,
refunded, failed, cost, and margin values remain `not_recorded` when the
repository does not contain them. Demand and revenue remain `not_measured`;
catalog listings, HTTP 402 responses, dry-runs, and executions do not prove
either one.

The private create/import rate limiter is process-local. It bounds one warm
process, but a new instance starts with an empty counter and multiple instances
do not share state. Distributed enforcement belongs at the deployment edge or
in a shared limiter and remains a production-hardening follow-up.

## Database and release gate

SQLite migrations 43, 44, and 45 add the Resource repository, publication
binding, and receipt facts after the existing migrations 38 through 42. The
hosted schema and prepared PostgreSQL artifact contain the same eight Resource
tables, immutable guards, indexes, constraints, RLS boundary, repository RPCs,
and a private Resource owner-adoption helper. The prepared Stripe migration
owns the hardened public adoption wrapper and composes its private Stripe
helper with the Resource helper in one transaction. The reviewed migrations
are replay-safe in either Resource/Stripe apply order and preserve Resource
rows, Stripe aliases, credits, and connections together on success or
rollback.

The PostgreSQL artifact is prepared only. Follow the separately authorized,
checksummed apply and readback sequence in
[`docs/migrations/PENDING.md`](migrations/PENDING.md). A passing local build or
preview does not apply SQL, deploy Resource Foundry, enable settlement, or
prove a live Resource Product.
