# Phase 0 preservation baseline

This baseline protects the working product while the open-core platform expands. It records evidence and release gates; it does not freeze future architecture.

## Starting point

- Clean implementation baseline: `06862da`.
- Rebased approved design: `c3ae073`.
- Before Phase 0 implementation: 47 test files, 751 tests, 76 templates, and 40 statically generated pages in a clean Next production build.
- The pre-existing default-parallel gateway timeout remains a reliability watch item. The deterministic release gate uses one Vitest worker and a 10-second per-test timeout; default parallel mode is also exercised separately before Phase 0 closes.
- `.next` is exclusive to one build process in a worktree. The gate removes it immediately before the application build, and no two Next builds may share the same worktree concurrently.

## Deterministic release gate

`npm run verify:phase0` records the current commit, then runs serially:

1. The complete Vitest suite with one worker.
2. The `@suedeai/agents` SDK TypeScript build.
3. A clean Next production build after deleting `.next`.

The runner stops at the first failure and prints success only after all three gates pass and the Git tree remains clean. It forces a disposable SQLite path, strips remote-database, paid-model, signer, wallet, RPC, and telemetry credentials from child processes, and cleans the temporary database in `finally`.

## Visual evidence

Start capture with `npm run capture:phase0:server`. It strips dotenv and shell credentials, forces a disposable SQLite database under the OS temp directory, forces settlement skip, prints a one-time session token, and deletes the database when stopped. Then `npm run capture:phase0 -- --base-url <loopback-origin> --output <absolute-directory> --session-token <token>` writes the privacy-safe manifest only after the server proves that isolated runtime. It also rejects non-loopback origins, dirty Git trees, unsafe or symlinked in-repository output paths, and atomic manifest overwrites. Desktop and mobile cover every route; the wide viewport is limited to Studio routes.

Rendered PNG files and checksums live outside Git in the dated Drive-vault artifact folder:

`05_handoffs/artifacts/2026-07-10-agent-studio-phase0/`

The final Phase 0 handoff links that folder and records the manifest commit. Capture uses a local server without imported browser cookies or storage state.

## Live safety

The live lane is read-only during baseline verification. A live run or launch is forbidden unless a separate zero-price fixture is intentionally created, verified, and deleted. Local execution remains dry-run by default and no paid provider or new subscription is required.
