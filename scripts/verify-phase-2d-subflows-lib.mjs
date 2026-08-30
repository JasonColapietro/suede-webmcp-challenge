import { runPhase1Verification } from "./verify-phase-1-lib.mjs";

const FOCUSED_TARGETS = Object.freeze([
  "tests/db/migrations.test.ts",
  "tests/db/phase1-supabase-migration.test.ts",
  "tests/db/phase2d-supabase-migration.test.ts",
  "tests/projects/subflow-version-pins.test.ts",
  "tests/api-subflows-v2.test.ts",
  "tests/api-subflow-breadcrumbs-v2.test.ts",
  "tests/api-flow-run-preflight.test.ts",
  "tests/api-flow-lifecycle.test.ts",
  "tests/api-versions-v2.test.ts",
  "tests/flow/callable-interface-commands.test.ts",
  "tests/flow/flow-mutation-service.test.ts",
  "tests/flow/subflow-contract.test.ts",
  "tests/flow/subflow-dynamic-ports.test.ts",
  "tests/flow/subflow-node.test.ts",
  "tests/flow/subflow-reference-ledger.test.ts",
  "tests/flow/studio-reference-session-gate.test.ts",
  "tests/flow/subflow-reference-paste.test.ts",
  "tests/flow/studio-paste-session.test.ts",
  "tests/flow/subflow-reference-ui.test.tsx",
  "tests/flow/run-subflow-preflight.test.ts",
  "tests/flow/run-dock-v2-run-route-source-contract.test.ts",
  "tests/lib/run-context.test.ts",
  "tests/lib/run-context-snapshot.test.ts",
  "tests/lib/run-service-subflow-recursion.test.ts",
  "tests/flow/engine-v2.test.ts",
  "tests/flow/loop-node.test.ts",
  "tests/flow/save-queue.test.ts",
  "tests/flow/flow-impact-dialog.test.tsx",
  "tests/flow/impact-confirmation-page-source-contract.test.ts",
  "tests/flow/pending-paste-page-source-contract.test.ts",
  "tests/flow/studio-navigation.test.ts",
  "tests/flow/studio-global-navigation-source-contract.test.ts",
  "tests/flow/studio-history-browser.test.ts",
  "tests/flow/studio-history-guard.test.ts",
  "tests/flow/studio-recovery.test.ts",
  "tests/flow/studio-recovery-bootstrap.test.ts",
  "tests/flow/studio-recovery-banner.test.tsx",
  "tests/flow/subflow-breadcrumbs.test.ts",
  "tests/flow/subflow-breadcrumb-session.test.ts",
  "tests/flow/subflow-studio-integration.test.ts",
  "tests/projects/subflow-breadcrumbs.test.tsx",
  "tests/projects/pinned-reference-banner.test.tsx",
  "tests/flow/builder-command-integration.test.ts",
  "tests/flow/builder-accessibility.test.ts",
  "tests/manifest/v2-schema.test.ts",
  "tests/manifest/v2-roundtrip.test.ts",
  "tests/manifest/versioning.test.ts",
  "tests/compat",
  "tests/scripts/verification-env.test.ts",
  "tests/scripts/verify-phase1.test.ts",
  "tests/scripts/verify-phase2a.test.ts",
  "tests/scripts/verify-phase2b.test.ts",
  "tests/scripts/verify-phase2c.test.ts",
  "tests/scripts/verify-phase2d.test.ts",
  "tests/scripts/verify-phase2d-subflows.test.ts",
]);

function commandStep(args) {
  return Object.freeze({
    kind: "command",
    command: "npm",
    args: Object.freeze(args),
  });
}

export const PHASE2D_SUBFLOW_STEPS = Object.freeze([
  commandStep([
    "test",
    "--",
    "--testTimeout=10000",
    "--maxWorkers=1",
    "--minWorkers=1",
    ...FOCUSED_TARGETS,
  ]),
  commandStep(["test", "--", "--testTimeout=10000", "--maxWorkers=1", "--minWorkers=1"]),
  commandStep(["run", "build", "--workspace=@suedeai/agents"]),
  Object.freeze({ kind: "remove", path: ".next" }),
  commandStep(["run", "build"]),
]);

export function runPhase2dSubflowVerification(options = {}) {
  return runPhase1Verification({
    ...options,
    phaseLabel: "Phase 2D reusable subflows",
    steps: options.steps ?? PHASE2D_SUBFLOW_STEPS,
  });
}
