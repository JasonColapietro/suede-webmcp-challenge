import { NODE_DEFS } from "@/lib/flow/registry";
import { sha256Utf8 } from "@/lib/flow/subflow-reference";
import { DURABLE_NODE_ADMISSION } from "./admission";

export const DURABLE_RUNTIME_POLICY_VERSION = 9;

/**
 * Reviewed source bytes for the complete Phase 3A execution boundary. The
 * source-contract test fails whenever one of these files changes without a
 * deliberate manifest and policy-version review.
 *
 * v4: added 8 new node types (docs.extractText, docs.extractDocx,
 * data.parseSpreadsheet, finance.generateInvoicePdf as "direct" replay-safe
 * local computation; comms.slackMessage, comms.crmWebhook,
 * devops.githubIssue, devops.githubWorkflowDispatch as "refuse" — they
 * reach a third party and must never be replayed). See admission.ts's
 * DURABLE_NODE_ADMISSION for the per-type classification this reviews.
 *
 * v5: reviewed structured upstream business-node inputs, guarded semantic
 * connection material for third-party actions, and lazy gateway executor
 * loading. Durable replay classifications remain unchanged.
 *
 * Manifest refresh (policy version unchanged): migrations/sqlite.ts v21 adds
 * the settlements accounting table — no durable runtime tables, admission
 * classifications, or replay semantics are touched.
 *
 * Manifest refresh (policy version unchanged): migrations/sqlite.ts v22 adds
 * the company tables (companies, departments, employees, approvals) —
 * organization/accounting only, no durable runtime impact.
 *
 * Manifest refresh (policy version unchanged): migrations/sqlite.ts v23-v25
 * add soft-removal history, approval action/cost snapshots, bounded activity
 * indexes, and strict reconciliation of preexisting additive columns. These
 * remain company governance/read-model changes and do not alter durable
 * admission, replay, execution, or event semantics.
 *
 * Manifest refresh 2026-07-20 (policy version unchanged): node-definitions
 * palette metadata only (group order reordered function-first, category
 * "Suede Tools" renamed "Music & IP") plus repo-layer createAgent now
 * writing an explicit settlement_live=false for new agents. Display
 * metadata and creation-time state; no durable admission, replay,
 * execution, or event semantics are touched.
 *
 * Manifest refresh 2026-07-21 (policy version unchanged): migrations/sqlite.ts
 * v27 adds trigger_input/run_variables columns to the legacy `runs` table so
 * a finished legacy run's exact original input can be resubmitted from the
 * run detail page ("Run again"). Legacy run-record storage only — no durable
 * runtime table, admission classification, or replay semantics are touched.
 *
 * Manifest refresh 2026-07-20b (policy version unchanged): the LLM node's
 * "model" field changed from free text to a named cost/speed tier picker
 * (node-definitions.ts, node-definition-types.ts widened NodeField.options
 * to allow labeled {value,label} entries). Field kind, label, hint, and
 * options are UI/config-authoring metadata only; llmParamsSchema, the
 * executor, and admission classification are unchanged.
 *
 * v6: added docs.knowledgeSearch as "direct" replay-safe local computation —
 * it chunks and ranks in-run-supplied document text with a dependency-free
 * TF-IDF cosine scorer, reads no upstream network resource, and writes
 * nothing, matching the existing docs.extractText / docs.extractDocx
 * review. See admission.ts's DURABLE_NODE_ADMISSION for the classification.
 *
 * v7: added data.filterRows, data.generateSpreadsheet, and
 * docs.generateReportPdf as bounded, connection-free local computation.
 * They are refused from the durable worker because their row/artifact outputs
 * can exceed its 48 KiB event and 128 KiB output envelopes. They remain
 * available through the reviewed legacy/test execution path.
 *
 * v8: added web.fetchUrl, a read-only GET node that wraps the SSRF-hardened
 * http executor and post-processes the body into text/JSON/a price number.
 * It is refused from the durable worker for the same reason as http — it
 * reaches a caller-controlled third-party URL over the network and must never
 * be replayed. It remains available through the reviewed legacy/test path.
 *
 * Manifest refresh 2026-07-22 (policy version unchanged): migrations/sqlite.ts
 * v30 adds the server-only `health_checks` table for the public /status
 * surface — infra reachability/latency snapshots written by the hourly cron
 * recorder. No durable runtime table, admission classification, replay,
 * execution, or event semantics are touched.
 *
 * Manifest refresh 2026-07-23 (policy version unchanged): migrations/sqlite.ts
 * v31 adds the `company_ceo_messages` table for the CEO chat feature —
 * persisted founder/assistant turns for an already-founded company, with a
 * confirm-gated action proposal attached to assistant turns. Company
 * governance/chat storage only — no durable runtime table, admission
 * classification, replay, execution, or event semantics are touched.
 *
 * Manifest refresh 2026-07-24 (policy version unchanged): migrations/sqlite.ts
 * v32 adds the nullable `company_employees.pay_to` column for individual
 * employee wallets — a per-employee payout address resolvePayout prefers
 * over the founder's owner wallet at settlement time. Company governance
 * storage only — no durable runtime table, admission classification,
 * replay, execution, or event semantics are touched.
 *
 * v9: added suede.promoClaims, a read-only node that fetches Suede Promo's
 * claim ledger over the network with a server-held agent key. It is refused
 * from the durable worker for the same reason as web.fetchUrl and http — it
 * reaches an external system and must never be replayed. Its dry run is
 * served by a stub, so no dry run reaches Promo. No existing node's
 * admission classification, replay, execution, or event semantics change.
 *
 * Manifest refresh 2026-07-24b (policy version unchanged): adds
 * src/lib/flow/backup.ts, the owner-scoped flow backup/restore archive. It
 * enters this manifest only because it lives under src/lib/flow. It defines
 * no node type, touches no admission classification, and adds no runtime
 * table: export reads flows through repo.listFlows, and restore creates
 * missing flow IDs through the existing FlowMutationService save path
 * (createOnly, never overwriting a current flow) with rollback of the flows
 * it created if any one fails. Graphs are revalidated on the way in with
 * SupportedFlowGraphSchema plus validateRunnableGraph, so a restored flow is
 * held to the same contract as a saved one. No durable replay, execution, or
 * event semantics are touched.
 *
 * Manifest refresh 2026-07-24c (policy version unchanged): suede.promo and
 * suede.promoClaims now return a config error when PROMO_AGENT_KEY is unset,
 * instead of sending `Bearer ` (empty) and surfacing Promo's 401 as if it were
 * an outage. The guard sits after the existing dry-run gate, so dry runs are
 * still served by the stub and never reach Promo. Both nodes are already
 * "refuse" in DURABLE_NODE_ADMISSION, so neither can enter the durable worker
 * at all — no admission classification, replay, execution, or event semantics
 * are touched. The change is a pre-network early return on the live path only.
 *
 * Manifest refresh 2026-07-24d (policy version unchanged): expr/index.ts
 * raises DEFAULT_EXPR_LIMITS.maxTimeMs from 50 to 1000. This is the transform
 * node's wall-clock backstop; maxSteps (a deterministic counter, unchanged at
 * 20000) remains the real bound on evaluation work. Reviewed specifically for
 * replay: the old value made a REPLAY-CLASSIFIED node's outcome depend on how
 * busy the host was — a trivial expression aborts if the process is
 * descheduled for 50ms mid-evaluation, so the same node could error on one
 * attempt and succeed on a replay. Loosening the backstop strictly reduces
 * that wall-clock dependence, making "direct" replay MORE deterministic, not
 * less. No node's admission classification, executor identity, event schema,
 * or durable runtime table changes.
 *
 * Manifest refresh 2026-07-24 (policy version unchanged): flowSaveFingerprint
 * now hashes canonical JSON (keys sorted) instead of raw JSON.stringify, and
 * the studio recovery storage key moves to v2 so envelopes carrying the old
 * key-order-dependent hashes are never compared against canonical ones. The
 * fingerprint is client-side studio bookkeeping — dirty-state, recovery
 * disposition, and version-restore comparison. It is not persisted server-side
 * and is not part of durable identity, so no node's admission classification,
 * executor identity, replay, event schema, or runtime table changes.
 *
 * Manifest refresh 2026-07-25 (policy version unchanged): db/migrations/sqlite.ts
 * runs the migration ledger's writes in IMMEDIATE transactions and re-checks
 * schema_migrations for the version it is about to apply while holding the
 * write lock, so parallel processes on one file (a second `next build` over an
 * existing studio.db) no longer replay a version and collide on
 * schema_migrations.version. Reviewed specifically for durable identity: no
 * migration's DDL, ordering, checksum, or signature changes, so every durable
 * runtime table, index, and trigger is byte-identical. Per-version transactions
 * are retained, so a mid-run failure still leaves the applied prefix committed.
 *
 * Manifest refresh 2026-07-25b (policy version unchanged): covers both the lock
 * timeout db/migrations/sqlite.ts now raises while migrating (#201, which moved
 * the aggregate without recording a note here) and the correction to its stated
 * reason. Measured on better-sqlite3 11.10.0: `new Database(path)` yields
 * busy_timeout = 5000, and a losing IMMEDIATE transaction waits that long before
 * SQLITE_BUSY — it is not refused instantly, and no caller in src/ opts out of
 * waiting. The raise is therefore about a cold migration outlasting a 5s budget,
 * not about a missing busy handler. withMigrationLockTimeout also no longer
 * widens a connection it cannot restore. Comments, a test's caller shape, and a
 * timeout value only — no migration DDL, ordering, checksum, or signature moves,
 * so every durable runtime table stays byte-identical.
 *
 * Manifest refresh 2026-07-26 (policy version unchanged): db/migrations/sqlite.ts
 * gains migration 33 `site-verifications` — one new APPENDED entry creating the
 * `site_verifications` table (domain-ownership proof that lets a site-drafted
 * agent into the public catalog; see lib/site/verification.ts). Reviewed
 * specifically for durable identity: purely additive — no existing migration's
 * DDL, ordering, checksum, or signature changes, the ledger stays contiguous
 * (32 → 33), and no durable runtime table, index, or trigger is touched. The
 * new table is read by the catalog and the verify route only; the engine,
 * worker, and replay paths never see it.
 *
 * Manifest refresh 2026-07-31 (policy version unchanged): db/migrations/sqlite.ts
 * gains migration 34 `stripe-revenue-receipts` and migration 35
 * `stripe-owner-adoptions` — an append-only private local receipt ledger for
 * signed Stripe topups/refunds, their atomic legacy credit mutation, and the
 * append-only owner alias lookup used after account adoption. Reviewed
 * specifically for durable identity: the new tables, indexes, and mutation
 * guards are additive; no durable execution table, trigger, admission
 * classification, worker, event schema, projection, or replay path changes.
 * The gateway webhook is outside durable execution.
 *
 * Manifest refresh 2026-07-30 (policy version unchanged): the Logic category
 * gains two pure nodes, `logic.switch` and `logic.aggregate`, both admitted
 * "direct". Reviewed specifically for durable identity: both are total
 * functions of their params and inputs with no I/O, no clock, no randomness,
 * no credential or connection binding, and no cost, so a replay reproduces
 * byte-identical outputs from the recorded inputs, exactly as `transform` and
 * `branch` already do. No migration, worker, enqueue, projection, or replay
 * boundary file changes.
 *
 * Manifest refresh 2026-07-30b (policy version unchanged): the AI category
 * gains `ai.classify` and `ai.extract`, both admitted "refuse". Reviewed
 * specifically for durable identity: both call the model provider through
 * ctx.llm exactly as `llm` does, so like `llm` they must never be replayed,
 * and "refuse" keeps them out of the durable worker entirely. Both are
 * cost-bearing and carry a dry-run stub, so a dry run returns a shaped
 * result without a provider request, and test-scoped-stubs.ts gains a fixed
 * scoped stub for each so a scoped test run cannot reach the model either.
 * No existing node's classification, and no migration, worker, enqueue,
 * projection, or replay boundary file, changes.
 *
 * Manifest refresh 2026-08-04 (policy version unchanged): SQLite gains the
 * private Prospect Engine record migration. It is outside durable execution;
 * no worker, enqueue, projection, replay rule, or admitted node changes.
 *
 * Manifest refresh 2026-07-30c (policy version unchanged): Dev & Infra gains
 * `devops.githubRead`, admitted "refuse". Reviewed specifically for durable
 * identity: it reaches api.github.com over the network, so like every other
 * outbound node it must never be replayed, and "refuse" keeps it out of the
 * durable worker entirely. It is read-only (GET, no body), takes its token
 * from a bound connection secret rather than a param, and delivers through
 * the SSRF-hardened http executor its write siblings already use. It carries
 * a dry-run stub and a fixed scoped test stub, so neither a dry run nor a
 * scoped test reaches GitHub. No existing node's classification, and no
 * migration, worker, enqueue, projection, or replay boundary file, changes.
 *
 * Manifest refresh 2026-08-05 (policy version unchanged): `src/lib/flow`
 * gains one file, `input-contract.ts`, and no existing file in the manifest
 * changes (verified: the diff against the prior attested commit touches that
 * path alone, and the prior commit re-verified green on a pristine checkout).
 * Reviewed specifically for durable identity: it is a pure projection that
 * reads a graph's input-node `fields` config and returns JSON Schema. It adds
 * no node, no executor, and no admission entry; it performs no I/O, holds no
 * state, and is never called from the durable worker, enqueue, projection, or
 * replay path. Its only consumers are the public catalog and the MCP tool
 * surface, both outside the replay boundary. No existing node's
 * classification, and no migration, worker, enqueue, projection, or replay
 * boundary file, changes.
 *
 * Manifest refresh 2026-08-06 (policy version unchanged): four files change —
 * `input-contract.ts`, `nodes/schedule.ts`, `nodes/webhook.ts`, and
 * `node-definitions.ts` — so that a schedule- or webhook-triggered agent can
 * publish a real MCP input contract instead of one that claims it accepts no
 * arguments. Verified on a pristine checkout that the prior attested commit
 * reproduces its committed aggregate, so the delta below is only these edits.
 *
 * This refresh touches an executor admitted "direct" (`schedule`), which is
 * replayed, so it gets the full review rather than the projection-only one:
 *
 * - `nodes/schedule.ts` now returns `{ ...(params.fields ?? {}), ...inputs }`
 *   where it returned `inputs`. This is the identical merge `nodes/input.ts`
 *   (also "direct") has always performed and which is already attested here.
 *   It stays pure: no I/O, no clock, no randomness, output a function of
 *   params and inputs alone, so replay remains deterministic.
 * - **No already-recorded run can change value.** A graph attested before this
 *   commit has no `fields` key on its schedule node, so `params.fields` is
 *   undefined and the merge degenerates to a shallow copy of `inputs` — the
 *   same JSON the old code emitted. Published versions are immutable, so an
 *   in-flight or replayed durable run executes its own frozen graph and
 *   observes byte-identical output. Behavior differs only for graphs that opt
 *   in by authoring `fields`, whose runs necessarily begin after this commit.
 * - `nodes/webhook.ts` takes the same merge but is admitted "refuse", so it
 *   never enters the durable worker and sits outside the replay boundary.
 * - `node-definitions.ts` adds an optional `fields` config key and one UI
 *   field to the schedule and webhook definitions. Additive and optional: no
 *   existing graph's params become invalid, and no node's admission changes.
 * - `input-contract.ts` remains a pure projection off the replay path; it now
 *   also reads schedule/webhook `fields` and distinguishes an omitted `fields`
 *   from an explicit empty one. Its only consumers are the public catalog and
 *   the MCP tool surface.
 *
 * No node is added or removed, no admission entry changes, and no migration,
 * worker, enqueue, projection, or replay boundary file changes.
 *
 * Manifest refresh 2026-08-06 (policy version unchanged): exactly one
 * manifest-covered file changes, `src/lib/db/migrations/sqlite.ts`, and it
 * changes only by appending SQLite migrations 36 (`company-org-roles`) and 37
 * (`company-employee-instructions`). Verified: `git diff --name-only` against
 * the prior attested commit intersects the manifest at that single path, and
 * that prior commit re-verified green on a pristine checkout before this
 * refresh was written (prior attested commit: b774c49, the schedule/webhook
 * input-contract refresh recorded directly above). Reviewed specifically for durable identity: both
 * migrations are additive company-domain DDL. 36 adds six nullable columns to
 * `company_employees` behind per-column existence guards plus one
 * `CREATE INDEX IF NOT EXISTS`; 37 adds `company_employee_instructions` behind
 * `CREATE TABLE IF NOT EXISTS`. Neither touches `runs`, `run_steps`, or any
 * durable runtime table; neither alters an existing migration's signature, so
 * every checksum below version 36 is unchanged and the applied prefix a worker
 * validates on boot is identical. No node, executor, or admission entry is
 * added, and no worker, enqueue, projection, or replay boundary file changes.
 *
 * Manifest refresh 2026-08-09 (policy version unchanged): exactly one
 * manifest-covered file changes, `src/lib/flow/nodes/llm.ts`. The llm
 * executor now prefers the client's usage-reporting variant
 * (`ctx.llm.generateWithUsage`, added to src/lib/llm.ts, which sits outside
 * this manifest) and returns `gatewayCostUsdc(usage.totalTokens)` as its
 * costUsdc, so the tokens a real provider call consumed surface in the run
 * ledger, the in-run cost ceiling, and the per-agent daily cap instead of a
 * hardcoded 0. Reviewed specifically for durable identity: `llm` is admitted
 * "refuse", so it never enters the durable worker and sits entirely outside
 * the replay boundary; no "direct" node's bytes or behavior change, so every
 * replayed node still reproduces byte-identical output from its recorded
 * inputs. The dry-run gate is untouched — the stub executor still runs for
 * every dry run, returning costUsdc 0 with no provider request — and a
 * client without generateWithUsage (minimal test doubles, scoped stubs)
 * keeps the historical zero-cost behavior. Entitlement checking and spend
 * recording live in run-context.ts and gateway/model-spend.ts, both outside
 * this manifest; this file's only change is reading reported usage into
 * costUsdc (plus the import of the pure pricing helper gatewayCostUsdc from
 * lib/billing.ts). No node is added or removed, no admission entry changes,
 * and no migration, worker, enqueue, projection, or replay boundary file
 * changes.
 *
 * Manifest refresh 2026-08-09 (policy version unchanged): exactly one
 * manifest-covered file changes, `src/lib/flow/node-definitions.ts`. The
 * change updates cost metadata for nine Suede compatibility nodes to match
 * the reviewed gateway profile defaults. Every affected node is admitted
 * `"refuse"`, so none can enter the durable worker or replay boundary; no
 * executor, params schema, admission entry, migration, enqueue, projection,
 * or worker behavior changes.
 *
 * Manifest refresh 2026-08-14 (policy version unchanged): the integrated
 * SQLite ledger appends prospect migrations 38-39, AP2 authorization/replay
 * and relay-v2 migrations 40-42, and Resource Foundry migrations 43-45. The
 * migration renumbering preserves every previously published 38-42 SQL body
 * byte-for-byte and changes no durable runtime table, index, or trigger.
 * Resource Foundry adds `resource.query`, but admission.ts classifies it
 * `"refuse"`; its executor can therefore never enter the durable worker or be
 * replayed. The Resource source, publication, and receipt tables are outside
 * durable execution. No admitted executor identity, event schema, worker,
 * enqueue, projection, retry, or replay behavior changes, so policy version 9
 * remains the reviewed boundary.
 *
 * Manifest refresh 2026-08-15 (policy version unchanged): the ephemeral
 * scoped-test policy now admits only the exact canonical static, free,
 * read-only `resource.query` runtime so owner-reviewed test runs can execute
 * it. Durable admission remains independently and explicitly `"refuse"` in
 * admission.ts, so no Resource read enters durable enqueue, worker, retry, or
 * replay behavior. No durable admission or executor identity changes.
 */
export const DURABLE_RUNTIME_SOURCE_MANIFEST = Object.freeze({
  algorithm: "sha256-of-sorted-sha256-lines-v1",
  aggregateSha256: "3eab5719185ce70bbc97bf9df5e298d6f76b38b9240df0392f71cfdb11ae2bbc",
} as const);

const REVIEWED_EXECUTOR_IDENTITIES = new Map(
  NODE_DEFS.filter((runtime) => DURABLE_NODE_ADMISSION[runtime.type] !== "refuse")
    .map((runtime) => [runtime.type, Object.freeze({ executor: runtime.executor, paramsSchema: runtime.paramsSchema, definition: runtime.definition })] as const),
);

export function durableRuntimePolicyFingerprint(): string {
  for (const runtime of NODE_DEFS) {
    const reviewed = REVIEWED_EXECUTOR_IDENTITIES.get(runtime.type);
    if (DURABLE_NODE_ADMISSION[runtime.type] === "refuse") {
      if (reviewed) throw new Error("Durable refused-node policy drift");
    } else if (!reviewed || reviewed.executor !== runtime.executor || reviewed.paramsSchema !== runtime.paramsSchema || reviewed.definition !== runtime.definition) {
      throw new Error("Durable executor identity drift");
    }
  }
  const definitions = NODE_DEFS.map((runtime) => ({
    type: runtime.type,
    disposition: DURABLE_NODE_ADMISSION[runtime.type],
    costBearing: runtime.costBearing ?? null,
    sideEffecting: runtime.sideEffecting ?? null,
    priceUsdc: runtime.priceUsdc ?? null,
    cost: runtime.definition.cost,
    effects: runtime.definition.effects,
    permissions: runtime.definition.permissions,
    capabilityMode: runtime.definition.capabilityMode,
    testMode: runtime.definition.testMode,
    retry: runtime.definition.retry,
  })).sort((left, right) => left.type.localeCompare(right.type));
  if (definitions.length !== Object.keys(DURABLE_NODE_ADMISSION).length ||
      definitions.some((entry) => !Object.hasOwn(DURABLE_NODE_ADMISSION, entry.type))) {
    throw new Error("Durable runtime policy enumeration drift");
  }
  return sha256Utf8(JSON.stringify({
    version: DURABLE_RUNTIME_POLICY_VERSION,
    sources: DURABLE_RUNTIME_SOURCE_MANIFEST,
    definitions,
  }));
}
