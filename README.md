# Suede Agent Studio

**A general-purpose agent builder with an available x402 packaging and launch path.**

A visual, node-graph builder — Gumloop-style, for any business workflow — where
you wire specialized agents on a canvas, package them with the Suede SDK and
modern agent rails (x402, ACP, A2A, on-chain identity), and launch eligible
flows through the available pay-per-call x402 path. This packaging path can make
a flow sellable to other agents in USDC; it is not proof that every local flow
is published or running on a hosted endpoint. Music and IP rails (generation, the IP registry, royalty
routing) are one built-in vertical; most of the template catalog is general
business workflows spanning contract review, lead scoring, invoice chasing,
support triage, and more.

> Build agents that get work done, and get paid.

## WebMCP Challenge

This repository is the public, MIT-licensed source snapshot for Suede Agent
Studio's OpenAI WebMCP Challenge entry. The existing application was extended
with WebMCP during the challenge window. The live directory registers four
page-scoped tools:

1. `find_services` searches the published service shelf by job-to-be-done.
2. `get_service` returns price, input contract, review policy, data handling,
   and worked examples before any action is taken.
3. `preview_service` creates a free dry-run receipt without model inference or
   payment. It is correctly marked as a write because it records the run.
4. `buy_service` spends only prepaid workspace credit after server-side origin,
   rate-limit, buyability, and exact-price checks. It is not used in the public
   challenge demo.

Try the live WebMCP surface at
[agents.suedeai.ai/agents](https://agents.suedeai.ai/agents) using ChatGPT's
in-app browser or a compatible Chrome WebMCP build.

- [Challenge evidence and implementation map](CHALLENGE_EVIDENCE.md)
- [Under-three-minute demo script](DEMO_SCRIPT.md)
- [Submission checklist](SUBMISSION_CHECKLIST.md)

The `"private": true` field in `package.json` prevents accidental publication
to the npm registry. It does not restrict this repository's MIT license.

## Stack

Next.js 15 · React 19 · TypeScript (strict) · `@xyflow/react` (canvas) ·
Vercel AI SDK + Claude · Supabase / SQLite · `viem` (Base) · zod · Tailwind v4.

## Quickstart

```bash
npm install
npm run dev      # http://localhost:3210 (or default 3000)
npm test         # vitest — engine, nodes, db, integration
npm run build    # production build
npm run verify:phase2a # isolated canonical-node release gate
npm run verify:phase2b # isolated graph-editing release gate
npm run verify:phase2c # credential-stripped typed-data release gate
npm run verify:phase2d # SQLite-only workbook-tabs release gate
npm run verify:phase2d:subflows # no-spend reusable-subflow release gate
npm run verify:phase2e # no-spend ephemeral scoped-test release gate
npm run verify:phase2f # no-spend version restore and promotion release gate
npm run verify:phase3a # no-spend replay-safe durable runtime release gate
npm run verify:phase4a # no-spend local connection release gate
npm run verify:phase4b1 # no-spend portable-operation simulation release gate
npm run verify:card-payment # end-to-end card top-up rail: checkout, signed webhook, credit, spend
```

`verify:card-payment` boots its own server on a throwaway database and needs no
Stripe account: webhook signatures are local HMAC, so the money-into-the-ledger
half runs for real. Creating a Checkout Session is the one step that needs
Stripe's API — supply a test key to cover it
(`STRIPE_SECRET_KEY=sk_test_... npm run verify:card-payment`); otherwise the run
reports that step as not covered. A live key is refused.

- Landing page: `/`
- Visual builder: `/build/new` (or `/build/new?template=lead-qualifier`, or
  `/build/new?template=song-register-royalty` for the music/IP vertical)
- A launched agent's public page: `/a/<slug>`
- Resource Foundry workspace: `/resources`

## Resource Foundry

Resource Foundry turns owner-selected material into a reviewed, immutable
Resource Pack for one narrow, typed job. Owners can start with manual text,
JSON rows, or a bounded public URL/site import; define the typed schema,
taxonomy, filters, return fields, and Job Contract; approve without supplying
provenance; test the exact pack; and publish it through the existing agent,
API, MCP, A2A, OpenAPI, catalog, and x402 rails. PDF, DOCX, CSV, spreadsheet,
and general file upload are not supported in this release. Public projections
come only from the same immutable active Live release; raw sources, private
records, credentials, private examples, and provenance notes stay out of
discovery. Resource relay registration is refused before publication or
payment because relay does not yet carry the exact prepared immutable Live
authority and canonical receipt.

See [`docs/resource-foundry.md`](docs/resource-foundry.md) for the owner and
buyer contracts, lifecycle, access behavior, query and receipt semantics,
privacy boundary, operating controls, and release gates. The prepared hosted
database migration remains unapplied; its separately authorized production
sequence is recorded in [`docs/migrations/PENDING.md`](docs/migrations/PENDING.md).

## Configuration

The legacy/core builder runs out of the box on its default SQLite store with
x402 in dry-run and no USDC spent. Durable execution has separate required local
configuration below and never defaults to `studio.db`.

### Local no-spend builder

Local graph editing works without provider credentials, settlement, or paid
services. The builder includes command-based editing with exact undo and redo,
multi-select duplicate and delete, redacting copy and paste, alignment and
distribution, deterministic auto-layout, keyboard shortcuts, and an accessible
command palette. Phase 2C adds conservative typed ports, workflow/run variables,
structured upstream and secret-reference bindings, exact v1 compatibility, and
lossless v2 manifest transport. Unknown schemas stay connectable and are marked
as untyped instead of being guessed compatible. SQLite remains the default local
store, and dry-run remains the default execution mode. Phase 2D adds exact v2
checkpoints and owner-scoped workbook tabs that save before changing flows while
preserving every existing flow row ID and `/build/<rowId>` URL. Its reusable
subflow slice adds strict callable interfaces, owner-scoped draft and immutable
pinned references, named typed inputs and outputs, cycle-safe nested execution,
server-derived dependency pins, impact-aware editing, and private validated
breadcrumbs. A pinned parent opens the child's current draft with an honest
immutable version and content-hash receipt instead of pretending the draft is
the pinned snapshot. Phase 2E adds node-only, run-to-node, and run-from-node
tests in the existing Inspector and Run Dock. Scoped tests require the exact
owner-scoped project Test environment, canonical values for every boundary pin,
and the private same-origin test route. They run through a closed ephemeral
runtime with bounded results, cancellation, a full-path deadline, and an exact
zero-cost receipt. They never resolve secrets, execute live effects, create
persistent runs, contact providers or payment rails, or mutate the default
database.

`npm run verify:phase2c` is the exact local no-spend release gate. It refuses a
dirty tree, strips provider, database, wallet, relay, webhook, and payment
credentials, forces disposable SQLite with settlement disabled, runs focused and
full serial tests, builds the SDK and application, and proves the default
`studio.db`, WAL, and SHM did not change.

`npm run verify:phase2d` is the exact local, credential-stripped, SQLite-only,
no-spend workbook-tabs release gate. It refuses a dirty tree, strips provider,
Postgres, Supabase, deployment, wallet, relay, webhook, and payment credentials,
uses a disposable SQLite database with settlement disabled, runs focused and
full serial tests, builds the SDK and application, and proves the default
`studio.db`, WAL, and SHM did not change. It never applies the prepared manual
PostgreSQL migration or calls a provider, deployment service, or payment rail.

`npm run verify:phase2d:subflows` is the separate exact-commit,
credential-stripped, SQLite-only, no-spend reusable-subflow gate. It freezes the
subflow contract, runtime, private API, manifest, command, paste, impact, pinned
reference, and breadcrumb suites before running the full serial tests and both
production builds. It inherits the same clean-tree, disposable-database,
unchanged-default-database, credential stripping, cleanup, and no-provider
guarantees as the workbook-tabs gate.

`npm run verify:phase2e` is the exact-commit, credential-stripped, SQLite-only,
no-spend ephemeral scoped-test gate. It freezes planning, canonical pins,
closed execution, owner and Test-environment authorization, strict private API,
bounded client parsing, Studio lifecycle, deadline, and cancellation behavior
before running the full serial tests and both production builds. It uses a
disposable SQLite database, proves the default database files did not change,
and never deploys, resolves secrets, contacts providers, or calls payment
rails. The gate does not replace manual UAT or a current-head visual capture.
Phase 3A now provides a narrow SQLite-only durable path for admitted replay-safe,
zero-monetary-budget immutable versions. Retry and restart-safe resume are
implemented as whole-run child/attempt operations. Runtime checkpoint writes,
mid-graph continuation, and effectful/provider-backed durable execution remain
deferred.

`npm run verify:phase2f` is the exact-commit, credential-stripped, SQLite-only,
no-spend version restore and promotion gate. It freezes deterministic immutable
structural diff, stale-safe command-backed restore, deployment confirmation,
Studio review UI, compatibility, and all prior verifier laws before the full
serial suite, SDK build, `.next` removal, and Next build. Restore copies an
immutable version into the mutable Draft, remains undoable, and does not
auto-save. Test and Live promotions are separate exact-receipt operations; a
Test receipt is not proof that the version passed tests. The gate uses disposable
SQLite, proves default database files stay unchanged, and does not deploy,
contact providers, call payment rails, or replace current-head visual UAT.

`npm run verify:phase3a` is the exact-commit, credential-stripped, SQLite-only,
no-spend durable runtime gate. It freezes additive migrations, immutable
admission, append-only events and projection rebuild, idempotent enqueue and
retry, multi-connection claims, lease fencing and recovery, controls, the
private v3 API, persisted SSE reconnect, Studio receipts, v2 compatibility,
and all prior verifier laws before the full serial suite and both builds. The
gate uses a disposable database, generates a fresh unprinted HMAC key, proves
the default database files are unchanged, and does not start a persistent or
production worker command, deploy, call a provider, or call payment rails. One
bounded local `run-runtime-worker.mjs` entrypoint smoke is intentionally spawned
only against disposable SQLite and is force-cleaned. Current-head browser evidence is unavailable;
automated DOM/source contracts do not replace manual UAT.

`npm run verify:phase4a` is the exact-commit, credential-stripped, SQLite-only,
no-spend local connection gate. It adds connection lifecycle, authenticated HTTP,
published Live execution, Studio picker, compatibility, and every prior verifier
law before the full serial suite and both builds. The gate generates fresh
unprinted connection-encryption and cron keys, uses disposable SQLite, and proves
the default database files are unchanged. Its five-step command manifest contains
no direct deploy, provider, payment-rail, remote-DB, or non-loopback network
command, and its isolated environment strips credentials. Strict no-egress
enforcement requires an external sandbox. The connection feature does not
remove costs or side effects imposed by the operator's compute, storage, or target
API.

The runtime connection provider can use the reviewed temporary shared Supabase
runtime when `DB_DRIVER=supabase`, the same protected
`CONNECTION_ENCRYPTION_KEY` is present on every app instance, and the public key
plus `AGENT_STUDIO_DB_SECRET` bridge is complete. It requires the manual
`docs/migrations/connections-production-shared-runtime.sql`; a service-role key
alone is deliberately not a connection-provider configuration. Source support
and a green build do not apply SQL or prove that hosted production connections
are available. Production activation requires the migration gate and archived
catalog readback documented in `docs/migrations/PENDING.md`.

`npm run verify:phase4b1` is the exact-commit, credential-stripped,
SQLite-only, no-spend portable-operation-kernel gate. Behind the default-off
Connector Lab flag, literal OpenAPI 3.1.0 JSON can produce immutable typed
`api.operation` assets for local simulation. The Studio labels them
`Prototype: simulation only`; a successful receipt says `Simulated locally. No
request sent.` Optional readiness reports only `Test slot configured.
Authentication unverified.` The feature never decrypts a credential or sends
the described request, and publish, Live, and durable execution refuse it. The
gate uses disposable SQLite and fresh local keys, strips inherited remote and
paid authority, installs process-level non-loopback sentinels, runs all Phase
4B1 and prior laws plus the full serial suite and both builds, and proves the
default database files and Git evidence did not change. It is not an OS-level
network-sandbox certification and does not claim broad OpenAPI or connector
parity. No required paid service was added; operator compute and storage can
still cost money.

For local durable operation, the app and worker must separately receive the
same explicit absolute `SQLITE_PATH` and the same strong, secret
`RUNTIME_IDEMPOTENCY_HMAC_KEY` containing at least 32 bytes. A worker must
actually run for queued jobs to progress. This is not a hosted, high-availability,
Postgres, effectful, or production-durability claim.

| Env | Default | Purpose |
| --- | --- | --- |
| `DB_DRIVER` | `sqlite` | `sqlite` or `supabase` |
| `SQLITE_PATH` | `studio.db` for legacy/core only | local DB file; durable runtime requires an explicit absolute path and never accepts this default |
| `RESOURCE_FOUNDRY_ENABLED` | enabled | emergency stop only: exact value `0` refuses Resource Foundry operations; it is not an entitlement or subfeature gate |
| `RUNTIME_IDEMPOTENCY_HMAC_KEY` | — | required for durable enqueue; same strong 32-byte-or-longer secret in the app and worker |
| `CONNECTION_ENCRYPTION_KEY` | none | required for SQLite or reviewed shared-runtime Supabase connections; the same 32-byte key, encoded as 64 lowercase hex characters and excluding the all-zero value, must reach every app instance and never the database |
| `CRON_SECRET` | none | required by `/api/cron/tick`; at least 32 UTF-8 bytes and sent by Vercel Cron as `Authorization: Bearer <value>` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | dedicated service-role configuration for general application persistence; reviewed baseline: `src/lib/db/schema.deploy.sql`; not sufficient for the connection provider |
| `SUPABASE_ANON_KEY` / `AGENT_STUDIO_DB_SECRET` | — | required shared-runtime connection bridge; requires the reviewed request-secret boundary and manual connections migration, never a browser client |
| `ANTHROPIC_API_KEY` | — | LLM node; falls back to a deterministic stub |
| `X402_SKIP_SETTLEMENT` | `true` | set `false` to settle real USDC on Base |
| `X402_PRIVATE_KEY` / `X402_SELLER_WALLET_ADDRESS` / `BASE_RPC_URL` / `SUEDE_API_URL` | — | live x402 settlement |
| `AP2_MODE` | `off` | experimental AP2 v0.2 merchant authorization: `off`, `optional`, or `required`; invalid values fail to `off` |
| `AP2_MERCHANT_ISSUER` | — | stable HTTPS issuer for merchant-signed checkout quotes and Checkout Receipts; required before AP2 can be advertised |
| `AP2_MERCHANT_SIGNING_JWK` | — | server-only ES256 P-256 private JWK with `kid`; keep in managed secrets and never expose it to clients or logs |
| `AP2_MERCHANT_RETIRED_JWKS_JSON` | — | optional JWKS containing up to 8 retired public ES256/P-256 verification keys; preserves receipt verification across active-key rotation and rejects private or remote key material |
| `AP2_TRUSTED_ISSUERS_JSON` | — | pinned issuer, algorithm, and public-key registry for accepted mandate signers; remote token-provided key URLs are never trusted |
| `AP2_REPLAY_STORE_READY` | unset | operator assertion set to `1` only after the durable AP2 authorization migration is applied and read back; runtime still probes the required table/columns and stays unavailable if that live probe fails |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | — | card top-ups — the non-x402 way to fund gateway credit. Both are required; unset, `/api/gateway/topup/stripe` answers 503 and the wallet-free path is simply off. Point a Stripe webhook endpoint listening for `checkout.session.completed` at `/api/gateway/topup/stripe/webhook` and use its signing secret |
| `PROMO_AGENT_KEY` | — | server-to-server key for `promo.suedeai.ai`; required by the `suede.promo` and `suede.promoClaims` nodes and the reviewer-gated promo-claims proxy. Unset, those nodes fail fast with a config error instead of calling Promo |
| `GOOGLE_PLACES_API_KEY` | none | optional Prospect Engine discovery via Google Places Text Search. Results are transient; selecting one performs a manual website import and no Google place provenance is persisted. Manual website import remains available when unset |
| `PROSPECT_SUPPRESSION_HMAC_SECRET` | none | required server-only secret (at least 32 characters) for versioned keyed recipient suppression digests. Draft, approval, handoff, delivery confirmation, and suppression fail closed when unset |
| `OPTIMIZE_OPERATOR_AUDIT_URL` / `OPTIMIZE_OPERATOR_AUDIT_TOKEN` | none | trusted server-to-server Optimize audit adapter for Prospect Engine. Both are required to run an audit; unsigned shared snapshots cannot seed the engine |
| `DEV_OWNER_ID` | `dev-user` | dev owner until real auth is wired |

## Architecture

Four isolated units around one frozen contract (`FlowGraph`):

1. **Canvas** (`src/components/canvas`) — `@xyflow/react` editor + palette + inspector + run dock.
2. **Flow contract** (`src/lib/flow/types.ts`, `node-meta.ts`) — the spine.
3. **Execution engine** (`src/lib/flow/engine.ts`) — topological run, per-node USDC cost ledger, error-branch halting, subflow guard.
4. **Runtime** (`src/lib/run-service.ts`, `src/app/api/*`) — flows CRUD, SSE runs, x402-gated agent runs, `.well-known` discovery, template export, cron.

Node executors live in `src/lib/flow/nodes/**`; 22 compatibility profiles are mapped in `src/lib/rails/suede-endpoints.ts`, with separate five-route operational and exact-three public/discoverable allowlists; the x402 client is `src/lib/rails/x402-client.ts`.

## Docs

- Design spec: [`docs/superpowers/specs/2026-06-07-suede-agent-studio-design.md`](docs/superpowers/specs/2026-06-07-suede-agent-studio-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-06-07-suede-agent-studio.md`](docs/superpowers/plans/2026-06-07-suede-agent-studio.md)
- Database deployment baseline: [`src/lib/db/schema.deploy.sql`](src/lib/db/schema.deploy.sql). SQL under [`docs/migrations/`](docs/migrations/) is manual-only and requires a live schema readback, reviewed dry run, and explicit apply approval. `src/lib/db/schema.sql` is a conflicting historical Supabase Auth bootstrap, not the deployment baseline.
- Prospect Engine production persistence uses [`prospect-engine-records.sql`](docs/migrations/prospect-engine-records.sql), followed by [`prospect-engine-production-shared-runtime.sql`](docs/migrations/prospect-engine-production-shared-runtime.sql) for the public-key plus request-secret Supabase bridge. Both were applied and read back in production on 2026-08-09.
- Canonical node definitions: [`docs/architecture/canonical-node-definitions.md`](docs/architecture/canonical-node-definitions.md). This is the one-source workflow for adding a node without palette, inspector, runtime, price, or dry-run drift.
- Typed reusable subflows: [`docs/architecture/typed-reusable-subflows.md`](docs/architecture/typed-reusable-subflows.md). This covers callable contracts, draft and pinned references, nested runtime boundaries, private breadcrumbs, safe Studio navigation, and the local no-spend gate.
- Ephemeral scoped tests: [`docs/architecture/ephemeral-scoped-tests.md`](docs/architecture/ephemeral-scoped-tests.md). This covers scope planning, canonical boundary pins, Test environment ownership, the private route, closed zero-cost execution, bounded Studio results, cancellation, and the local no-spend gate.
- Version restore and promotion: [`docs/architecture/version-restore-promotion.md`](docs/architecture/version-restore-promotion.md). This covers immutable structural diff, undoable mutable-Draft restore, the Test-to-Live confirmation chain, non-claims, and current-head manual UAT.
- Durable runtime: [`docs/architecture/durable-runtime.md`](docs/architecture/durable-runtime.md). This covers the database-backed whole-run queue, at-least-once fencing, controls, persisted reconnect, local worker operation, strict nonclaims, and the Phase 3A gate.
- Connections: [`docs/architecture/local-connections.md`](docs/architecture/local-connections.md). This covers SQLite and Supabase provider gates, Test and Live slots, exact static-auth transformations, immutable published execution, encryption and adoption identity, bounded usage review, no-network UAT, and the Phase 4A gate.
- Portable operation kernel: [`docs/architecture/portable-operation-kernel.md`](docs/architecture/portable-operation-kernel.md). This covers the strict OpenAPI subset, immutable operation assets, local schema simulation, metadata-only readiness, portable rebinding, audit/privacy boundaries, explicit nonclaims, and the Phase 4B1 gate.
