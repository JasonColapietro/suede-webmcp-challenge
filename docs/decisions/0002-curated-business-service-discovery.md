# RFC: Curated business-service discovery

Date: 2026-08-13
Status: accepted
Deciders: Jason Colapietro

## Problem statement

Agent Studio publishes machine-readable catalog, x402, MCP, Agent Cards, OpenAPI,
robots, sitemap, and `llms.txt` surfaces, but the individual business services
do not yet share a complete product contract. Most live instances have no
semantic description, named inputs, output schema, or realistic example.
Coinbase Bazaar also consolidates UUID path segments, so the existing
`/api/agents/<uuid>/run` resource is indexed as one parameterized Agent Studio
route instead of one resource per service. A crawler can reach the studio but
cannot reliably distinguish, compare, or call the five services selected for
the first curated collection.

## Proposed solution

Create one code-owned contract registry for these exact live service slugs:

- `po-match-gate-mkgu0`
- `contract-red-flag-scan-chm9v`
- `vendor-risk-read-q0jjq`
- `expense-policy-check-l8o5i`
- `bank-rec-discrepancy-finder-bw0tt`

Each contract defines its service key, buyer intent, description, tags, typed
input and output JSON Schemas, safe synthetic examples, review boundary, and
data-handling disclosure. Exact slug matching is deliberate: a customer who
launches a copy of the same template is not represented as Suede-curated.

Project the same contract through:

1. `/api/catalog` and a curated `/api/services` feed;
2. slug-based canonical run URLs;
3. per-service and root x402 discovery, including service-specific Bazaar
   request examples and output schemas;
4. MCP tool descriptions, input schemas, output schemas, and safety hints;
5. A2A 1.0 Agent Cards plus native HTTP+JSON `SendMessage` execution, with
   structured data mapped through the same validated x402 run path;
6. OpenAPI, `llms.txt`, robots, sitemap, and public service pages.

The run and MCP paths validate the same curated input contract before any
payment or workspace-credit movement. Existing non-curated agents continue to
derive their contract from the published graph.

## Alternatives considered

### Treat every instance of a business template as curated

Rejected because template identity proves how a flow started, not who operates
it. Customer-created copies would inherit a Suede curation claim they did not
earn.

### Replace the public catalog with only five services

Rejected because it would break current creator listings and existing API
consumers. The curated feed is additive, while the general catalog remains
backward compatible.

### Update the five production graphs in the database

Deferred. It requires authenticated production mutation and republishing each
immutable deployment. A source-level contract registry fixes discovery and
pre-payment validation without a data migration. A later owner-authorized
republication can move the fields into the graphs.

## Risks

- A slug can be retired or replaced. Exact matching fails closed: the service
  drops out of the curated feed instead of attaching curation to the wrong
  agent.
- Model output can violate its advertised schema. Discovery examples are not a
  guarantee of every generated response. The public response retains raw run
  outputs, and normalized structured output is emitted only when it can be
  parsed safely.
- Business documents can contain sensitive data. Service metadata states that
  inputs and outputs are stored in run history and links to the privacy and
  deletion surfaces. No zero-retention claim is made.
- A successful paid CDP settlement is still required before Bazaar can index a
  new resource. Code and local verification cannot prove external indexing.

## Success criteria

- The curated feed returns exactly the five intended live slugs when all five
  are present, with complete descriptions, schemas, examples, and honest
  readiness fields.
- Every curated run URL uses its slug, not its UUID.
- An unpaid, valid example request reaches HTTP 402 before execution when
  settlement is live; malformed curated input is rejected before payment.
- x402 Bazaar metadata is different for each service and validates its own
  example against its declared input contract.
- MCP `tools/list` exposes typed input and output schemas for the five services;
  invalid input never moves workspace credit.
- Per-service Agent Cards contain the current required A2A discovery fields,
  advertise `HTTP+JSON` 1.0, and execute structured `message:send` requests.
- Focused tests, TypeScript, lint, and production build pass locally.
- Production deployment, paid canaries, and external Bazaar indexing remain
  separately proven release steps.

## Decision record

Accepted. The product direction was narrowed in order to curated inventory,
then business services. The additive exact-slug registry gives that collection
a trustworthy machine contract without mutating customer inventory or current
production data.
