# Ephemeral scoped tests

Phase 2E lets a builder test one selected node, everything through a selected
node, or everything from a selected node without creating a durable run or
enabling a live capability. The Studio keeps full-flow execution and scoped
testing as separate modes that share one cancellation-safe Run Dock lifecycle.

## Test scopes

The Inspector exposes three actions for a selected node:

| Studio action | Request scope | Nodes included |
| --- | --- | --- |
| Run node | `{ "kind": "node", "nodeId": "..." }` | The selected node only |
| Run to node | `{ "kind": "to-node", "nodeId": "..." }` | The selected node and its required upstream closure |
| Run from node | `{ "kind": "from-node", "nodeId": "..." }` | The selected node and its reachable downstream closure |

The planner derives the exact execution order from the submitted v2 graph. A
request cannot supply its own node list or execution order.

## Required boundary pins

A partial graph can depend on values produced outside its execution scope. The
planner turns each of those boundaries into a required pin for an edge input,
node binding, or edge condition. Pin keys are canonical JSON tuples emitted by
the planner. The request must contain the exact required key set, with no
missing or additional keys.

The Studio renders JSON inputs for data pins and boolean controls for condition
pins. It validates and bounds every value before assembling the request. Secret
references are not boundary values and secret values are never resolved for a
scoped test.

## Private route and Test environment ownership

The Studio sends scoped tests to:

```text
POST /api/v2/flows/<flowId>/test
```

The route is browser-private. It accepts only same-origin `application/json`
requests without an `Authorization` header. Other methods return `405` with
`Allow: POST`. Responses use private, no-store JSON handling and fixed error
messages that do not echo submitted data.

The route resolves the read-only owner, then reads the flow through
`getOwnedFlow(flowId, ownerId)`. It separately reads the owner-scoped project
context and requires all of the following before execution:

1. The flow is bound to the returned project.
2. The submitted environment belongs to that same project.
3. The environment kind is exactly `test`.

The Studio derives that environment ID from current project context. It does
not hardcode an environment or accept a draft, staging, or live environment as
a substitute.

## Admission, deadlines, and cancellation

The route performs bounded, process-local admission by owner and IP. Admission
has token-bucket rate limits, owner and global concurrency ceilings, bounded
key maps, and a fixed retry response. Requests do not queue.

One 10-second deadline covers ownership resolution, admission, flow and project
reads, request parsing, planning, and execution. A client disconnect is combined
with that deadline. Cancellation closes the active iterator, emits a bounded
cancelled test result when execution has started, and suppresses late work at
the Studio lifecycle boundary. A deadline returns `504`; a client cancellation
returns `408` when the server can still answer.

## Closed, zero-cost execution

The server parses the exact request shape, plans the scope again, verifies the
canonical boundary pins, and executes the compiled projection through the
normal engine under a closed scoped-test policy. The compiled request has
`dryRun: true`, but safety does not depend on each node remembering to inspect
that flag.

Canonical node definitions declare whether test execution is native, stubbed,
or refused. Native execution is limited to approved pure behavior. Guarded
nodes use non-echoing scoped stubs. Refused nodes fail closed. Nested subflow and
loop execution is also refused at this boundary.

A scoped test therefore:

- reports exactly `$0.000 USDC`;
- does not resolve secret values;
- does not perform write, delete, send, publish, settlement, or other live effects;
- does not contact LLM providers, deployment services, webhooks, relays, wallets,
  payment rails, or on-chain services;
- does not create or update persistent run rows;
- does not mutate a flow, project, environment, or default database.

Durable jobs, retries, replay, fork, resume, pause, dead letters, execution
checkpoints, and long-running tests remain Phase 3 work.

## Bounded Studio results

The route returns one strict `{ "result": ... }` envelope. Events, logs, captured
outputs, identities, nesting, aggregate bytes, and metrics are bounded and
sanitized on the server. Cost is fixed at zero. The Run Dock renders bounded
outputs, status, and latency from the validated result.

The client accepts only canonical JSON media and a canonical content length
when one is present. It reads into one bounded byte buffer, caps the chunk
count, decodes fatal UTF-8, and validates the exact result envelope before the
Studio renders it. The visible log, ledger, and output lists are capped while
the validated result retains bounded rows behind the summary.

Switching between full-flow and scoped modes aborts the previous request,
clears canvas statuses, and ignores stale stream frames, JSON completions,
errors, and cleanup callbacks from the older generation. Full-flow runs keep
their SSE path. Scoped tests use the private JSON route and display the scope,
Test environment name, required pins, outputs, status, latency, and zero-cost
receipt.

## Local release gate

Run the exact Phase 2E gate from a clean committed tree:

```bash
npm run verify:phase2e
```

The gate is credential-stripped, SQLite-only, and no-spend. It runs the focused
scoped-test contract, policy, engine, route, client, Studio, cancellation, and
adversarial suites, followed by the full serial test suite, SDK build, and Next
build. It uses a disposable SQLite database, refuses source drift, and proves
the default `studio.db`, WAL, and SHM are unchanged. It does not deploy, apply a
PostgreSQL migration, contact a provider, or call a payment rail.

The gate proves source and build behavior. It does not replace manual UAT or a
current-head visual capture for the user-visible Inspector and Run Dock. The
implementation was exercised with local HTTP smoke checks, but the current
handoff has no browser screenshot because the in-app browser runtime reported
no available browser. Complete manual keyboard, focus, responsive layout, and
visual checks before a public release.

## Manual UAT checklist

Run these checks against the exact committed head before release:

1. Select a node and complete Run node, Run to node, and Run from node.
2. Supply required JSON and condition pins, then verify invalid or incomplete pins block the request.
3. Confirm the receipt names the owner-scoped Test environment and shows `$0.000 USDC`.
4. Start a scoped test, switch scope or full-flow mode, and verify the old request aborts without late status changes.
5. Confirm output, status, logs, and latency are visible and bounded on success and error.
6. Run the legacy full-flow action and verify its SSE behavior is unchanged.
7. Repeat with keyboard-only navigation, narrow and wide viewports, and a current-head visual capture.
