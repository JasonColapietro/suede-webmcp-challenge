# Canonical Node Definitions

Phase 2A gives every built-in node one client-safe definition shared by the runtime, palette, inspector, validation metadata, and future typed-port tooling.

## Source of truth

`src/lib/flow/node-definitions.ts` is the only authored product catalog. It contains JSON-safe data only and imports no executor, provider, environment, credential, registry, or Node-only module.

Each `NodeDefinitionV2` declares:

- identity, label, category, description, search terms, and icon;
- ordered inspector field presentation and a descriptive configuration JSON Schema;
- input and output port IDs with placeholder schemas;
- conservative possible effects and capability-resolution mode;
- permissions, test behavior, retry classification, and cost metadata.

The JSON Schema is descriptive metadata in Slice A. Runtime Zod schemas remain the executable validation authority. The release gate proves their top-level keys agree. Slice C will replace placeholder port schemas with enforceable typed-port schemas.

`src/lib/flow/node-meta.ts` is a compatibility projection. Do not author node data there. Free and variable-cost nodes intentionally omit the legacy `priceUsdc` property; consumers normalize absence as free or display the canonical variable-cost label.

## Runtime attachment

Built-in executors use `defineExecutableNode(definition, runtime)` from `src/lib/flow/executor.ts`. The adapter retains the exact catalog object and derives the legacy `type`, `label`, `group`, `priceUsdc`, `inputs`, and `outputs` fields.

`testMode` controls wrapper dispatch:

- `native`: run the node's real local executor in a test;
- `stub`: the central engine must substitute a zero-cost stub;
- `refuse`: the central engine fails closed and never calls the real executor.

Conservative capability disclosure does not automatically gate a wrapper. Subflow and loop nodes declare inherited effects but remain native wrappers because each child node applies its own central dry-run rule.

The explicit `NODE_DEFS` list remains the server audit and tree-shaking surface. The release gate proves its type set exactly equals the catalog.

## Adding a built-in node

Complete these steps in order:

1. Add the new value to `NodeType` in `src/lib/flow/types.ts`.
2. Add one pure descriptor to `NODE_DEFINITION_BY_TYPE` in `src/lib/flow/node-definitions.ts`.
3. Implement the runtime Zod schema, executor, and required dry-run stub under `src/lib/flow/nodes/`.
4. Attach the descriptor with `defineExecutableNode`; for priced Suede endpoints, use `suedeNode` so endpoint and descriptor price drift fails during module initialization.
5. Add the executable to the explicit `NODE_DEFS` list in `src/lib/flow/nodes/index.ts`.
6. Run `npm run verify:phase2a` from a clean committed tree.

Do not add parallel metadata to `node-meta.ts`, a component, or a route.

## Security boundary

The client catalog must never contain functions, credential values, private keys, bearer tokens, secrets, or imports from server/provider/environment modules. Permissions and future secrets are references and labels only.

Effect and cost declarations are conservative. A node may disclose more possible capability than a particular configuration uses; it must never disclose less. HTTP is configuration-dependent. Subflow and loop inherit from the referenced graph.

Every cost-bearing or side-effecting built-in must either declare a central zero-cost stub or refuse test execution. Tests enumerate every built-in and prove the real executor is unreachable in dry-run mode when guarded.

## Verification

`npm run verify:phase2a`:

1. requires a clean Git commit and records the commit/tree;
2. acquires the repository verifier's OS-temporary lock;
3. fingerprints the real `studio.db`, WAL, and SHM paths;
4. creates isolated HOME, XDG, temp, and SQLite state;
5. strips provider, payment, settlement, Postgres, and Supabase credentials and disables telemetry;
6. runs the focused compatibility/security suite and complete serial suite;
7. builds the SDK and Next application;
8. proves Git and default-database evidence unchanged;
9. removes owned temporary state and releases the lock even after failure.

The verifier does not deploy, connect to Supabase/Postgres, call a provider, settle payment, or use the default database.
