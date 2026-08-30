import { runPhase1Verification } from "./verify-phase-1-lib.mjs";

const FOCUSED_TARGETS = Object.freeze([
  // SQLite v7 and the prepared, manual-only PostgreSQL contract.
  "tests/db/workbook-tabs-migration.test.ts",
  "tests/db/phase2d-supabase-migration.test.ts",
  // Owner-scoped repository and private API behavior.
  "tests/projects/workbook-tabs-repo.test.ts",
  "tests/api-workbook-tabs-v2.test.ts",
  // One accessible tablist and save-before-navigation behavior.
  "tests/projects/workbook-tabs-ui.test.tsx",
  "tests/projects/workbook-tabs-navigation.test.ts",
  "tests/projects/workbook-tabs-ui-source-contract.test.ts",
  "tests/projects/route-row-id.test.ts",
  // Exact v1/v2 checkpoints, route row IDs, and queued-save compatibility.
  "tests/projects/ui-contract.test.ts",
  "tests/projects/ui-source-contract.test.ts",
  "tests/projects/sqlite-project-repo.test.ts",
  "tests/api-versions-v2.test.ts",
  "tests/flow/save-queue.test.ts",
  "tests/flow/builder-accessibility.test.ts",
  "tests/compat",
  // Hardened environment/evidence runners, including this non-recursive gate.
  "tests/scripts/verification-env.test.ts",
  "tests/scripts/verify-phase1.test.ts",
  "tests/scripts/verify-phase2a.test.ts",
  "tests/scripts/verify-phase2b.test.ts",
  "tests/scripts/verify-phase2c.test.ts",
  "tests/scripts/verify-phase2d.test.ts",
]);

function commandStep(args) {
  return Object.freeze({
    kind: "command",
    command: "npm",
    args: Object.freeze(args),
  });
}

export const PHASE2D_STEPS = Object.freeze([
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

export function runPhase2dVerification(options = {}) {
  return runPhase1Verification({
    ...options,
    phaseLabel: "Phase 2D",
    steps: options.steps ?? PHASE2D_STEPS,
  });
}
