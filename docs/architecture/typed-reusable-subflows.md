# Typed reusable subflows

Suede Agent Studio can call an owned flow from another flow through either a
typed draft reference or an immutable pinned reference. The implementation is
SQLite-first, owner-scoped, fail-closed, and compatible with legacy
`params.flowId` nodes.

## Reference model and callable interface

A callable interface declares stable input and output port IDs, JSON Schemas,
required and cardinality rules, trigger JSON Pointer targets, and exact output
node/port sources. The interface hash covers only that canonical strict
interface.

A draft reference embeds the child flow ID, callable interface, and interface
hash. A pinned reference also embeds an immutable version ID and content hash.
Mixed legacy and typed envelopes, unsafe port IDs or pointers, caller-supplied
hash drift, and contradictory references are refused.

## Draft and pinned child behavior

Draft references follow the owned child's accepted draft and fail when its
interface drifts. Pinned references resolve the exact immutable version and
content hash even after the child draft changes. Opening a pinned child in the
Studio opens its current editable draft. An in-context provenance banner shows
the immutable version and compact content hash used by the parent and warns
that the draft may differ.

## Nested runtime and recursion boundaries

Typed subflows map named inputs into the child's trigger targets and project
only declared outputs. Typed loops keep one fixed `items` input, a reserved
`errors` output, and ordered nullable arrays for child outputs. Direct, transitive, mixed
draft/pinned, and runtime cycles are refused by flow row identity. Depth and
shared cost reservations are bounded, and nested dry runs cannot execute real
HTTP, LLM, settlement, or other guarded effects.

## Dependency pins and portable manifests

Immutable checkpoints and versions derive pinned flow dependencies on the
server from the accepted graph. Caller-supplied flow pins are refused. Typed
draft references are not portable immutable manifests, while validated pinned
references round-trip with their exact dependency receipts. Legacy v1 graphs
and `params.flowId` execution remain supported without silently claiming typed
or pinned guarantees.

## Private reference and breadcrumb APIs

Reference candidates, versions, resolution, dependents, and breadcrumbs are
owner-scoped private APIs. The breadcrumb route is POST-only, `private,
no-store`, limited to 32 trail entries and a 32 KiB request, and returns the
same private `404` for missing, foreign, broken-adjacency, stale-version, or
hash-tampered trails. A directly opened flow returns no synthetic crumbs. Flow
names render only after server validation.

## Studio save and navigation ordering

Child and ancestor navigation accepts only an unmodified primary activation.
The Studio saves first, rechecks the graph and exact reference, physically
unwinds its browser-history guard, stages the breadcrumb and focus handoff
atomically, and then routes. Save refusal, graph or reference drift,
unavailable session storage, or staging failure leaves the user on the current
workflow. Modified and auxiliary activations are intentionally refused.

Return focus is one-shot. It is applied only after the target graph loads and
only when that graph still contains the exact parent wrapper node.

## Session handoff limits

The Studio navigation handoff is same-browser session state, not URL state or
durable project history. It is capped at 12 trail entries, 16 KiB, and ten
minutes. It stores bounded opaque flow, node, and version IDs plus timestamps,
a nonce, and reference hashes. It does not store names, graphs, node params,
bindings, or secret values. Breadcrumbs do not survive shared links, separate
tabs, or arbitrary browser restarts.

## Local no-spend verification

Run `npm run verify:phase2d:subflows` from a clean exact commit. The gate is
credential-stripped, SQLite-only, and no-spend. It uses disposable SQLite with
settlement disabled, runs frozen focused and full serial suites, builds the SDK
and Next application, proves the default `studio.db`, WAL, and SHM are
unchanged, and cleans temporary state. It does not apply PostgreSQL migrations,
contact a provider, deploy, or settle a payment.

## Hosted-runtime boundary

Prepared PostgreSQL migration files remain manual and unapplied. They are not
reachable from application startup, builds, tests, or verification. Unsupported
repository capabilities fail closed. Passing the local gate does not claim a
live deployment or hosted Supabase verification.
