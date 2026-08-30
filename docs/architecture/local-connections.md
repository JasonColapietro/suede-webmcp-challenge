# Connections

Phase 4A introduced owner-scoped static API credentials with SQLite persistence.
The runtime provider now supports an explicitly configured SQLite or Supabase
repository with the same public contract. One logical connection has independent
Test and Live slots. A workflow stores only the logical connection ID and the
semantic field `headers`; it never stores an environment, credential value, or
provider-specific secret field.

This is a self-hostable connection kernel. It does not require a paid connector
service, although hosted Supabase is an optional persistence provider. Operator
compute and storage can still cost money. The target API can charge fees,
rate-limit requests, or perform real side effects. Repository support in source
does not prove that a production schema, key, or provider environment is active.

## Current execution boundary

The Test and Live slots are separate encrypted records with independent status
and secret-version receipts. The server, not the graph or request body, chooses
which slot an execution may use.

Current previews, dry-runs, and scoped Test runs resolve no connection slot. This
is the dry-run zero-resolution boundary. A configured Test slot is visible as
lifecycle metadata but is not executable. No Test execution is claimed.
Test-slot execution remains unavailable until a separately verified Test
deployment runner exists.

Published agent, webhook, and schedule runs can resolve the Live slot only after
the server proves all of the following:

1. The flow belongs to the supplied owner.
2. The flow has one active, non-retired Live deployment.
3. The deployment is bound to that flow's Live project environment.
4. The deployment points to an immutable version whose stored semantic and full
   hashes still match.
5. Every nested subflow or loop reference is pinned, owner-scoped, hash-matched,
   and present in the preflighted immutable closure.
6. The active deployment receipt is unchanged after closure validation.

The active immutable Live root and its pinned closure are the only eligible
graph. The mutable Draft is never substituted for that root version or pinned
closure. Missing, retired, Test-only, owner-mismatched, version-mismatched, or
changed deployment state fails before connection resolution or HTTP dispatch.

## Exact authentication transformations

All four connection kinds expose the same semantic `headers` capability.

| Kind | Public metadata | Secret input | Outbound headers |
| --- | --- | --- | --- |
| API key | One configured header name | API-key value | `<configured-name>: <api-key-value>` |
| Bearer | No credential metadata | Token | `Authorization: Bearer <token>` |
| Basic | No credential metadata | Username and password | `Authorization: Basic <base64(UTF-8 username:password)>` |
| Custom headers | One to 16 configured header names | One value for every exact configured name | Each configured name receives its submitted value |

The Basic username and password are both secret. A Basic username cannot contain
a colon. API-key and custom-header names must be 1 to 64 ASCII token characters,
must be case-insensitively unique, and cannot be `Host`, `Cookie`, or a prohibited
hop-by-hop header. Connection headers cannot collide case-insensitively with
static HTTP-node headers.

Secret values are not interpolated. The HTTP node receives a frozen header map
through request-scoped execution provenance. Dry-run dispatch uses the central
HTTP stub before the real executor, so it neither resolves credentials nor sends
a request.

## Same-origin authenticated redirects and response containment

The HTTP node validates the initial URL and every redirect target. When connection
headers are present, a redirect may continue only if its normalized scheme,
hostname, and effective port match the first request. A cross-origin redirect is
refused before a second authenticated request is sent.

Authenticated responses are also checked for credential canaries. Reflected
credential material, invalid credential-bearing JSON, oversized bodies, and
unsafe response shapes return fixed failures instead of entering run outputs.

## Owner filtering and encrypted storage

Connection APIs resolve the authenticated owner before opening the repository.
Runtime resolution captures one owner and the server-selected environment. Both
repository implementations filter by owner ID, connection ID, environment, and
configured status before decrypting any row.

Slot material uses AES-256-GCM. Its authenticated identity binds the owner,
connection ID, authentication kind, Test or Live environment, schema version,
secret version, and canonical public configuration hash. Tampering or using a
different key makes the slot unreadable and returns a fixed private failure.

SQLite and Supabase records also store an immutable `crypto_owner_id`. A new
connection starts with `owner_id` and `crypto_owner_id` equal. Workspace
adoption changes only the access owner, advances the lifecycle revision and
updated timestamp, and never rewrites `crypto_owner_id` or re-encrypts a
secret. SQLite performs that move in the same transaction as the rest of the
anonymous workspace adoption; Supabase uses the reviewed adoption RPC wrapper.
The original cryptographic owner therefore remains the AES-GCM identity anchor
after adoption. This is one-owner adoption, not transfer between teams or
general credential sharing.

Rotation overwrites the one active ciphertext row for that slot. Revocation sets
the active nonce, ciphertext, authentication tag, and key version to `NULL` while
retaining non-secret lifecycle metadata. This is active-record minimization, not
a forensic-erasure guarantee. Old bytes can remain in database pages or WAL,
filesystem snapshots, backups, or storage-provider copies outside the
application's active row. This active ciphertext minimization is not a
forensic-erasure claim.

## Operator key setup and loss

Connections are available only when `CONNECTION_ENCRYPTION_KEY` is exactly 32
bytes encoded as 64 lowercase hexadecimal characters, excluding the all-zero
value, and one complete provider configuration is present:

- SQLite: `DB_DRIVER=sqlite` and an explicit absolute `SQLITE_PATH`.
- Temporary shared Supabase runtime: `DB_DRIVER=supabase`, a Supabase project URL,
  a public/anon key, and a strong `AGENT_STUDIO_DB_SECRET` matching the reviewed
  server-only request-secret boundary.

The provider does not fall back to `studio.db`, switch drivers, or generate a
key. A service-role key alone does not enable the connection provider. The
temporary shared production lane requires the unchanged manual migration at
`docs/migrations/connections-production-shared-runtime.sql`, including its owner
adoption wrapper and catalog readback. Builds and deploys never apply that SQL;
until a named operator applies it under the migration gate and archives readback,
hosted production connections remain unproven.

For local SQLite, generate the connection key and cron secret into a mode-600
file without printing them:

```bash
install -d -m 700 "$HOME/.config/suede"
umask 077
SUEDE_CONNECTION_ENV="$HOME/.config/suede/connections.env" node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; const body = `export CONNECTION_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nexport CRON_SECRET=${randomBytes(32).toString("hex")}\n`; writeFileSync(process.env.SUEDE_CONNECTION_ENV, body, { mode: 0o600, flag: "wx" })'
chmod 600 "$HOME/.config/suede/connections.env"
. "$HOME/.config/suede/connections.env"
export DB_DRIVER=sqlite
export SQLITE_PATH=/absolute/path/to/suede-connections.db
npm run dev
```

Load the same `CONNECTION_ENCRYPTION_KEY` wherever the app must read these slots.
Back it up through the operator's protected secret-storage process. There is no
master-key rotation or recovery workflow. Losing or replacing the key makes
existing configured slots unreadable; the service fails closed and the operator
must reconfigure each slot with new credential material.

For Supabase, inject that same key into every app instance through the deployment
secret store. Never store it in the database or pass it to an RPC. Supabase stores
only AES-256-GCM envelopes and lifecycle metadata. A database backup without the
application key cannot decrypt a configured slot; a lost application key cannot
be recovered from Supabase.

`CRON_SECRET` is a separate secret and must contain at least 32 UTF-8 bytes.
Vercel Cron calls `/api/cron/tick` with this exact header:

```text
Authorization: Bearer $CRON_SECRET
```

The route accepts no alternate scheme, spacing, casing, or extra token text.

## Lifecycle and usage lower bounds

Owners can create and rename a logical connection, configure or rotate either
slot, revoke a configured slot, and reconfigure a revoked slot. Mutations require
the current lifecycle revision. A stale revision refuses the write. Secret
values are submitted on mutation and are never returned by connection reads.

Before rotate, reconfigure, or revoke, the manager loads owner-scoped usage for
the current lifecycle revision. Usage includes current saved Draft graphs and
immutable versions attached to active Test or Live deployments. It excludes
inactive historical versions, run history, and retired deployments.

The scan has artifact, graph-size, total-byte, match, and page limits. Its
`matchedLowerBound` is always a lower bound. When `truncated` is true, display the
result as at least that many references, not as an exact total. A lifecycle
change invalidates the review and requires a fresh scan.

## Costs and side effects

The connection kernel has no paid connector dependency, and the HTTP node's
Suede price is zero. That does not make a live authenticated request free or
read-only. The target API can bill the operator, spend account credits, send
messages, modify records, or trigger any operation allowed by the credential and
HTTP method. Review the target API's pricing, permissions, idempotency behavior,
rate limits, and failure semantics before promoting a workflow to Live.

## Durable runtime refusal

Phase 3A durable admission still refuses secret-bearing or effectful graphs. A
credential-bearing HTTP graph cannot create a durable execution, invocation,
job, idempotency, usage, or event row. Phase 4A does not enable secrets, HTTP,
providers, browsers, payments, or other effects in the durable worker.

## Exact local release gate

Run the gate only from the clean commit being evaluated:

```bash
npm run verify:phase4a
```

The gate inherits the Phase 3A exact HEAD/tree evidence, single-process lock,
disposable SQLite database, runtime HMAC, default `studio.db`/WAL/SHM
fingerprints, and aggregate cleanup laws. It blanks inherited connection and
cron values, creates fresh unprinted 32-byte hex keys, then runs exactly five
steps: focused serial Phase 4A and all prior verifier laws; the full serial test
suite; Agent SDK build; `.next` removal; and the Next production build.

The five-step command manifest does not recursively invoke another release
verifier or contain a direct persistent-worker, deploy, provider, payment-rail,
remote-DB, or non-loopback network command. The isolated environment strips
credentials. Strict no-egress enforcement requires an external sandbox. The gate
does not replace manual operator acceptance against the same reviewed commit.

## Manual no-network UAT checklist

This checklist verifies the SQLite lane only; it is not a Supabase migration or
hosted-runtime acceptance test. Keep external network access blocked or observed.
Use only a disposable absolute SQLite path, local identities, and synthetic
credential values. Do not use a real provider credential or target account.

1. Record the current commit and tree. Fingerprint the default `studio.db`, WAL,
   and SHM, then start the app with a disposable absolute `SQLITE_PATH` and a
   protected generated connection key.
2. Open `/connections`. Create each of the four authentication kinds and confirm
   both Test and Live begin as missing without any secret readback.
3. Configure Test and Live with distinct synthetic values. Reload the page and
   confirm only kind, public header names, slot state, lifecycle revision,
   secret-version receipts, and timestamps remain visible.
4. In `/build/<owned-flow-id>`, bind an HTTP node to one logical connection.
   Inspect the saved graph and confirm it contains only the connection ID and
   `field: "headers"`, with no environment or submitted value.
5. Set the HTTP URL to `https://example.invalid/should-not-run` and execute a
   dry-run. Confirm the HTTP stub reports that the request was skipped, the
   connection resolver is not called, and the network monitor records no egress.
6. Confirm the picker shows separate Test and Live states and states that current
   previews and scoped Test runs resolve no credentials.
7. Open Rotate or Revoke. Confirm the manager loads current Draft and active
   deployment usage before enabling the mutation, labels truncated results as a
   lower bound, and refuses a stale lifecycle revision.
8. Revoke one synthetic slot. Confirm it becomes revoked, no submitted value is
   returned, and the active slot row has null nonce, ciphertext, authentication
   tag, and key version. Do not describe this as forensic deletion.
9. Stop the app, remove the disposable database and protected test key file, and
   compare the default database fingerprints and exact Git tree with the initial
   evidence.

This no-network checklist does not prove a successful authenticated request to a
real target. The focused automated suite verifies exact header transformations,
Live-only authority, immutable closure selection, owner-before-decrypt behavior,
redirect containment, and fixed failures with injected repositories, DNS, and
fetch implementations. A real target integration requires separate approval,
a controlled credential, and an explicit review of its costs and effects.

## Deferred capabilities and nonclaims

The following are not implemented by this connection kernel:

- OAuth authorization, refresh, scopes, consent, or provider revocation
- native provider connectors or paid connector aggregators
- OpenAPI import, GraphQL, email, or SQL/database connectors
- MCP client or server integration
- dynamic account-specific option loading, polling cursors, subscriptions, or
  automatic reauthentication
- Test-slot execution or a Test deployment runner
- team-shared credentials, roles, run-as identity, or cross-owner transfer
- hard deletion of logical connections or lifecycle metadata
- master-key rotation, key recovery, hosted KMS, managed backup, or high
  availability
- forensic erasure of database history, WAL, backups, snapshots, or storage copies
- durable execution for secret-bearing or effectful workflows
