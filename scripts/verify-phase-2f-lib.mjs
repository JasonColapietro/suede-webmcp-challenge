import { runPhase1Verification } from "./verify-phase-1-lib.mjs";

const FOCUSED_TARGETS = Object.freeze([
  "tests/projects/version-diff.test.ts",
  "tests/projects/version-service.test.ts",
  "tests/api-version-compare-v2.test.ts",
  "tests/projects/hash.test.ts",
  "tests/projects/hash-v2.test.ts",
  "tests/projects/version-restore.test.ts",
  "tests/flow/version-restore-page-source-contract.test.ts",
  "tests/flow/graph-history.test.ts",
  "tests/flow/graph-command-reducer.test.ts",
  "tests/projects/deployment-service.test.ts",
  "tests/api-deployments-v2.test.ts",
  "tests/db/deployment-migration.test.ts",
  "tests/projects/sqlite-project-repo.test.ts",
  "tests/projects/version-review-dialog.test.tsx",
  "tests/projects/ui-contract.test.ts",
  "tests/projects/ui-source-contract.test.ts",
  "tests/flow/impact-confirmation-page-source-contract.test.ts",
  "tests/compat",
  "tests/scripts/verification-env.test.ts",
  "tests/scripts/verify-phase1.test.ts",
  "tests/scripts/verify-phase2a.test.ts",
  "tests/scripts/verify-phase2b.test.ts",
  "tests/scripts/verify-phase2c.test.ts",
  "tests/scripts/verify-phase2d.test.ts",
  "tests/scripts/verify-phase2d-subflows.test.ts",
  "tests/scripts/verify-phase2e.test.ts",
  "tests/scripts/verify-phase2f.test.ts",
]);

function commandStep(args) {
  return Object.freeze({
    kind: "command",
    command: "npm",
    args: Object.freeze(args),
  });
}

export const PHASE2F_STEPS = Object.freeze([
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

export function runPhase2fVerification(options = {}) {
  return runPhase1Verification({
    ...options,
    phaseLabel: "Phase 2F version restore and promotion",
    steps: options.steps ?? PHASE2F_STEPS,
  });
}
