# Durable runtime

Phase 3A is a narrow, SQLite-only durable execution MVP for admitted replay-safe graphs. It is a local and self-hosted no-spend path. Here, zero-cost means zero monetary and token budgets and no paid provider call. It does not mean that CPU, memory, disk, or operator time is free.

## Current verified boundary

The current database-backed queue stores immutable executions, ordered append-only events, jobs, attempts, idempotency reservations, usage, and lease state separately from legacy `runs` and `run_steps`. Enqueue commits the execution, one ready whole-run job, and events 1 and 2 atomically. The API request never runs the graph.

Only an immutable version whose complete resolved closure passes admission can enter this path. The closure must be provider-free, effect-free, secret-free, bounded, cancellation-aware, and deterministic or explicitly replay-safe. Unknown policy metadata fails closed. Zero monetary and token budgets are enforced both at admission and while events are persisted.

The first scheduler unit is a whole-run job. A worker claims it in a short SQLite transaction, receives a random lease token, executes outside the transaction, heartbeats, observes controls, and finalizes only while its exact job, attempt, worker, and lease token still match. Recovery is at-least-once with fencing, not universal exactly-once execution. A stale worker can finish local computation but cannot append or finalize after lease loss.

The schema reserves execution checkpoint and lineage structures, but Phase 3A does not write runtime checkpoints. Final production checkpoint creation, mid-graph checkpoint continuation, replay from a node boundary, and per-node durable scheduling remain deferred.

## Local worker operation

The application and worker must point to the same explicit absolute `SQLITE_PATH`. They must also share the same strong `RUNTIME_IDEMPOTENCY_HMAC_KEY`, containing at least 32 bytes of secret material. Generate it with a CSPRNG into a mode-600 local environment file, source that same file in both terminals, and never echo, print, log, or commit it.

```bash
install -d -m 700 "$HOME/.config/suede"
umask 077
SUEDE_DURABLE_ENV="$HOME/.config/suede/durable.env" node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync(process.env.SUEDE_DURABLE_ENV, `export RUNTIME_IDEMPOTENCY_HMAC_KEY=${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" })'
chmod 600 "$HOME/.config/suede/durable.env"

# terminal 1
. "$HOME/.config/suede/durable.env"
export DB_DRIVER=sqlite
export SQLITE_PATH=/absolute/path/to/suede-durable.db
npm run dev

# terminal 2, sourcing the same secret file and using the same database path
. "$HOME/.config/suede/durable.env"
export DB_DRIVER=sqlite
export SQLITE_PATH=/absolute/path/to/suede-durable.db
npm run worker
```

`npm run worker` is a local/self-hosted worker loop. Running the web application without a worker can enqueue work, but it cannot make queued work execute. No always-on hosted worker, scheduler, high-availability topology, or production durability is claimed.

## Controls and recovery

- Cancel records the desired state. Ready work cancels immediately; leased work observes cancellation through heartbeat and `AbortSignal` boundaries.
- Pause is cooperative at persisted engine-event boundaries.
- Resume starts another whole-run attempt from the frozen definition. The UI calls this restart-safe resume, not checkpoint resume.
- Retry creates a child execution with immutable lineage. It does not mutate or rewind the terminal source stream.
- Exhausted bounded attempts enter a dead letter state once.

The private v3 API exposes enqueue, owner-scoped projection read, persisted SSE, and strict action routes. SSE reconnect uses `after=N` and matching `Last-Event-ID`. Closing a reader never changes execution state. RunDock keeps the accepted run identity and last sequence in same-session `sessionStorage`; it does not claim cross-browser, cross-device, or durable server-side client cursor persistence.

## Exact local release gate

Run the gate only from the clean commit that is being evaluated:

```bash
npm run verify:phase3a
```

The gate inherits exact clean HEAD/tree evidence, a single-process lock, disposable SQLite, default `studio.db`/WAL/SHM fingerprints, aggregate cleanup failures, and credential stripping. Its Phase 3A wrapper additionally blanks every inherited `DURABLE_*` value and generates a fresh unprinted 32-byte `RUNTIME_IDEMPOTENCY_HMAC_KEY`. It then runs exactly five steps: focused serial Phase 3A, compatibility, and prior-verifier laws; the full serial suite; Agent SDK build; `.next` removal; and the Next production build.

The gate does not start a direct persistent or production worker command, contact a provider, deploy, apply a remote database migration, or call a payment rail. One bounded local `run-runtime-worker.mjs` entrypoint smoke is intentionally spawned only against disposable SQLite and is force-cleaned. Multiprocess claim tests create their own disposable coordination variables after the isolation boundary.

## Manual fault and UAT checklist

Before starting, fingerprint the default `studio.db`, WAL, and SHM; create a disposable absolute SQLite path; strip provider, wallet, payment, webhook, browser, deployment, and remote-database credentials; and block or observe external network access. Use only local test identities and fixtures.

1. Start the app and one worker against the same disposable absolute SQLite path and shared strong HMAC key loaded from the protected file above.
2. Save an immutable admitted zero-monetary-budget version, enqueue it, and confirm queued, claimed, attempt, node, and terminal events remain contiguous.
3. Close and reopen the event reader. Confirm it resumes from `Last-Event-ID` without duplicates and that reader disconnect does not change execution state.
4. Stop a worker after claim, wait for the lease to expire, start another worker, and confirm recovery is fenced and bounded.
5. Request cancel during execution and pause at an event boundary. Confirm stale completion is refused and restart-safe resume creates a new attempt.
6. Retry a terminal run twice with the same key. Confirm one immutable child and unchanged source history.
7. Edit the mutable Draft after enqueue. Confirm the run still uses the pinned immutable version.
8. Prove admission refusal with a known harmless webhook-trigger-only fixture containing no downstream node, URL, secret, credential, or external destination. Confirm refusal occurs before durable persistence. Because a `422` can intentionally fall back to v2, do not use an effectful node for this check.
9. Exercise every state-valid action with the keyboard. Confirm focus returns to a persistent receipt/status destination and status plus incoming events announce politely.
10. Force a durable admission `422`. Confirm the unchanged v2 transport starts, a visible Legacy receipt explains the fallback, and focus moves to that persistent notice.
11. Reload version history through loading, failure, and confirmed ready-empty states. Confirm loading/error never flashes an executable Legacy Run and ready-empty labels Legacy honestly.
12. On run detail, confirm there is one live persisted event timeline, incoming events appear without duplication, fabricated trigger/start controls are absent, and the single Node results card spans the page.
13. Inspect the fixed-height Studio dock at 900, 760, and 759 pixels. Check keyboard order, visible primary focus rings, overflow/stacking, and reduced-motion behavior.
14. Finish by removing disposable test artifacts and comparing the default `studio.db`, WAL, and SHM fingerprint with the pre-test evidence.

Current-head browser evidence is unavailable for this slice. The automated DOM and source contracts pass, but they do not replace a current-head browser capture and keyboard/manual UAT.

## Nonclaims and deferred work

Phase 3A does not claim universal exactly-once effects, free compute or operations, runtime checkpoint writes, mid-graph checkpoint continuation, effectful or provider-backed durable jobs, browser automation, payments, hosted Postgres claiming, horizontal or high-availability workers, an always-on hosted worker, or production durability. Those capabilities remain target/roadmap work until separately designed, implemented, tested, and verified.
