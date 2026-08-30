# Portable operation kernel

Phase 4B1 adds an experimental Connector Lab for turning one bounded local
OpenAPI 3.1.0 JSON operation into a typed, immutable workflow asset. The resulting
`api.operation` node is **Prototype: simulation only**. It proves local wiring
and schema behavior; it does not call the described API.

Enable the lab locally with:

```bash
NEXT_PUBLIC_CONNECTOR_LAB_ENABLED=1 npm run dev
```

The flag reveals the local JSON importer, the owner-scoped connector browser,
and the specialized Studio picker. Flag-off requests and UI paths fail closed.
The node is excluded from templates, public directory claims, published runs,
Live execution, and durable execution.

## What simulation does

The builder selects one immutable operation version, pins its connector,
operation, and schema hashes, and stores only an optional logical connection ID
plus the semantic capability `http.headers`. `Simulate workflow` validates the
typed request namespaces (`path`, `query`, `headers`, and optional `body`),
builds a redacted request plan, and generates a deterministic schema-shaped
sentinel in trusted local code. The sentinel may flow through supported local
downstream nodes, but neither input values nor sentinel values appear in the
receipt.

A successful Run Dock receipt says exactly:

> Simulated locally. No request sent.

Simulation opens no connection provider, resolves no Test or Live slot,
decrypts no credential, performs no settlement, and has `egressCount: 0` and
`costUsdc: 0`. A connection is not required, even when the imported operation
declares authentication.

`Check Test readiness` is separate and optional. It uses a metadata-only reader
that can see the same owner's connection kind, public header names, lifecycle,
and whether a Test slot is configured. It cannot read or decrypt slot material.
The positive result says exactly:

> Test slot configured. Authentication unverified.

That sentence is configuration evidence, not a login, health, identity, scope,
network, or provider check.

## Literal import boundary

The compiler accepts UTF-8 JSON with literal `openapi: "3.1.0"`. It does not
accept YAML, OpenAPI 3.0, Swagger 2, a URL, remote references, or retained raw
source. A supported operation has:

- exactly one static public HTTPS origin;
- one unique `operationId`, method, and path;
- scalar path, query, and header parameters with fixed OpenAPI serialization;
- an optional JSON request body;
- one selected 2xx JSON response, or a bodyless 204;
- no authentication, or exactly one API-key header, HTTP Bearer, or HTTP Basic
  scheme;
- closed JSON Schemas using only `type`, `properties`, `required`, `items`,
  `additionalProperties: false`, numeric and length/item bounds, nullable
  two-entry unions, and the supported `date-time`, `date`, `time`, `email`,
  `hostname`, `ipv4`, `ipv6`, `uri`, and `uuid` string formats.

Unknown schema keywords, composition, polymorphism, files, multipart, streams,
cookies, OAuth, OpenID Connect, mutual TLS, callbacks, webhooks, links, dynamic
servers, unsafe origins, ambiguous success responses, credential-header
collisions, and fixture-like fields refuse with bounded fixed codes. Examples,
defaults, long prose, request/response bodies, rejected values, and raw source
are never persisted.

The `connector-import-v1` limits are:

| Boundary | Limit |
| --- | ---: |
| UTF-8 input | 2 MiB |
| JSON depth | 64 |
| object keys plus array entries | 50,000 |
| operations | 250 |
| parameters per operation | 64 |
| schema depth | 32 |
| local-reference expansions | 1,000 |
| inspected values | 100,000 |
| compiler deadline | 5 seconds |
| imports per owner per minute | 10 |
| canonical projection | 256 KiB |
| terminal receipt | 64 KiB |

## Identity, policy, audit, and privacy

The importer stores a sanitized connector index and materializes one operation
at a time. Canonical connector, operation, and schema projections receive
separate SHA-256 identities. Reimporting equivalent supported structure reuses
the same immutable version. A structural change creates a new version and drift
receipt without changing earlier graphs.

The trusted system policy is always `write / unsafe / unknown / none`: write
effects, unsafe retry, unknown cost, and no idempotency claim. Any author note is
displayed separately as `Unverified` and grants no authority.

Accepted or refused import, operation creation, and simulation paths
write bounded append-only audit events with an owner-bound correlation ID.
Creation and its audit commit atomically. Simulation releases no receipt or
output until its one terminal audit event is durable. Audit failure returns
`AUDIT_UNAVAILABLE`. Events and receipts omit raw source, payloads, output
values, credential values, authorization headers, and rejected input values.

## Portability and rebinding

V2 export carries exactly one sanitized dependency bundle per referenced
operation version: the canonical parent and operation projections, immutable
version IDs, and all three hashes. Owner-local connection IDs are replaced by a
stable unresolved binding requirement and capability. Import rejects missing,
extra, duplicate, or hash-mismatched bundles, recreates or reuses immutable
assets under the importing owner, and leaves the connection unresolved until
that owner explicitly chooses a compatible connection. No secret or raw source
is exported. Legacy v1 transport refuses the node instead of dropping it.

## Explicit nonclaims

Phase 4B1 does not provide outbound execution for `api.operation`. Publish,
Live, and durable admission return `API_OPERATION_LIVE_UNAVAILABLE` before
provider or connection access. It does not deliver provider authentication,
provider health, provider identity, side effects, OAuth, provider-native
connectors, broad OpenAPI support, a connector marketplace, or connector parity.
It does not add audit browsing, enterprise RBAC, team sharing, or compliance
export.

The kernel uses local parsing and local/self-hosted storage with no required paid service.
That is a dependency and automated-verification boundary, not a
promise that an operator's compute or storage is free.

## Release gate

Run from an exact clean commit and tree:

```bash
npm run verify:phase4b1
```

The gate holds one process lock, fingerprints the default `studio.db`, WAL, and
SHM, creates disposable absolute SQLite and fresh local keys, strips inherited
connector/provider/payment/deploy/remote-database/browser authority, and adds
throw-on-call guards for non-loopback network and deploy/browser command seams.
It runs the complete Phase 4B1 and prior-law matrix serially, then the full
serial suite, Agent SDK build, clean `.next`, and Next production build. Cleanup,
database evidence, Git evidence, and lock release are aggregated even after a
failure.

This is a process-level verifier. It is not an OS-level network sandbox and is
not strict no-egress certification. Final release evidence must also record the
local browser journey with non-loopback interception; no provider or deployed
UAT is implied.
