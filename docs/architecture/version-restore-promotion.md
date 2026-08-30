# Version Restore and Promotion

Slice F adds exact review, undoable restore, and explicit immutable promotion to
the Studio. Its local release gate is `npm run verify:phase2f`, an exact-commit,
credential-stripped, SQLite-only, no-spend verifier.

## Structural diff semantics

The private compare route compares two immutable versions. Its deterministic
structural diff reports added, removed, and changed nodes, edges, variables, and
dependency pins. It separates semantic changes from position-only movement and
marks a receipt layout-only only when graph meaning is unchanged. The receipt is
bounded and hash-bound to the exact selected records. It does not compare the
mutable Draft with an immutable version and does not claim to explain runtime or
business impact.

## Immutable versions and the mutable Draft

An immutable version is a checkpoint receipt. The current canvas remains the
mutable Draft. Restore copies a selected immutable graph into that Draft through
the accepted `graph.replace` command, refuses a stale expected Draft hash, and
does not mutate or delete the source version. The restore is one undoable graph
edit, does not auto-save, and can be undone before the operator explicitly saves.
Restore is not rollback of a Test or Live deployment.

## Test and Live confirmation chain

Promotion never starts from an unsaved Draft. Test promotion requires the exact
immutable version and content hashes, the expected active Test receipt, and the
typed confirmation `PROMOTE TEST`. It creates one immutable Test deployment
receipt atomically or fails without replacing the active receipt.

Live promotion is a separate operation. The selected immutable version must be
the exact active Test source, and the request must bind that Test deployment ID,
the expected active Live receipt, and the typed confirmation `PROMOTE LIVE`. It
creates one immutable Live deployment receipt atomically or fails without
replacing the active receipt. A Test receipt is not proof that the version passed tests;
it proves only which immutable version is active in the Test environment.

## Release gate and non-claims

`npm run verify:phase2f` freezes the Slice F diff, restore, graph-history,
deployment adapter/API, Studio UI, compatibility, environment-isolation, and all
prior verifier-law suites. It then runs the full test suite serially, builds the
SDK, removes `.next`, and runs the Next production build, in that order. It uses
disposable SQLite with settlement disabled, strips provider, Postgres, Supabase,
deployment, webhook, relay, wallet, and payment credentials, and proves exact
HEAD/tree plus unchanged default `studio.db`, WAL, and SHM evidence.

The gate does not deploy, contact providers, run payment rails, apply PostgreSQL
migrations, test organizational deployment rollback, prove runtime correctness
against external systems, or replace operator acceptance. Execution checkpoints
and organizational deployment rollback remain outside Phase 2.

## Manual UAT checklist

Run this checklist against the same current HEAD that passed the gate:

1. Open a flow with at least two immutable versions and confirm keyboard focus
   reaches each Review action, remains inside the dialog, closes with Escape,
   and returns to the connected trigger.
2. On desktop and a mobile viewport, confirm the Draft/Test/Live rail stays
   readable, the version ledger does not overflow, and empty, loading, error,
   truncated, and layout-only diff states remain distinguishable.
3. Review a version containing node, edge, variable, dependency, and layout
   changes. Confirm every structural bucket and immutable hash receipt matches
   the selected comparison.
4. Restore that version, confirm no save occurs, undo it once, and verify the
   exact pre-restore Draft returns. Repeat after making the Draft stale and
   confirm restore refuses without changing the canvas.
5. Promote to Test only after typing `PROMOTE TEST`. Confirm the receipt changes
   to the selected immutable version without claiming a test pass.
6. Confirm Live remains unavailable for a version that is not the active Test
   source. Then type `PROMOTE LIVE` for the exact active Test version and verify
   the Live receipt records the bound Test source.
7. Recheck the source commit and tree after UAT and record any visual capture
   against that exact current-head state.

Automated browser evidence is unavailable for this Slice F gate because the
browser runtime remained unavailable. No screenshot or current-head visual UAT
is claimed here; that evidence must be recorded manually when a browser is
available.
