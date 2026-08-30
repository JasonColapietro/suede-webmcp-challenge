import { runPhase1Verification } from "./verify-phase-1-lib.mjs";

const FOCUSED_TARGETS = Object.freeze([
  "tests/projects/api-response.test.ts",
  "tests/projects/ui-contract.test.ts",
  "tests/api-flow-test-v2.test.ts",
  "tests/flow/test-input-safety.test.ts",
  "tests/flow/test-scope.test.ts",
  "tests/flow/test-scope-source-contract.test.ts",
  "tests/flow/test-run-contract.test.ts",
  "tests/flow/test-node-policy.test.ts",
  "tests/flow/test-scoped-stubs.test.ts",
  "tests/flow/test-run-engine.test.ts",
  "tests/flow/test-runner-contract.test.ts",
  "tests/flow/test-runner-source-contract.test.ts",
  "tests/flow/test-runner.test.ts",
  "tests/flow/test-route-admission.test.ts",
  "tests/flow/test-run-route-source-contract.test.ts",
  "tests/flow/test-run-client.test.ts",
  "tests/flow/test-run-ui.test.ts",
  "tests/flow/run-dock-scoped-mode.test.tsx",
  "tests/flow/run-dock-lifecycle.test.tsx",
  "tests/flow/run-dock-v2-run-route-source-contract.test.ts",
  "tests/flow/inspector-test-actions.test.ts",
  "tests/flow/test-run-page-source-contract.test.ts",
  "tests/flow/studio-reference-gate-ui-source-contract.test.ts",
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
]);

function commandStep(args) {
  return Object.freeze({
    kind: "command",
    command: "npm",
    args: Object.freeze(args),
  });
}

export const PHASE2E_STEPS = Object.freeze([
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

export function runPhase2eVerification(options = {}) {
  return runPhase1Verification({
    ...options,
    phaseLabel: "Phase 2E ephemeral scoped tests",
    steps: options.steps ?? PHASE2E_STEPS,
  });
}
