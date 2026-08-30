import { runPhase1Verification } from "./verify-phase-1-lib.mjs";

const FOCUSED_TARGETS = Object.freeze([
  "tests/flow/graph-command-contract.test.ts",
  "tests/flow/json-patch.test.ts",
  "tests/flow/graph-command-reducer.test.ts",
  "tests/flow/graph-command-adversarial.test.ts",
  "tests/flow/graph-geometry.test.ts",
  "tests/flow/graph-layout.test.ts",
  "tests/flow/graph-history.test.ts",
  "tests/flow/save-queue.test.ts",
  "tests/flow/graph-fragment.test.ts",
  "tests/flow/builder-command-integration.test.ts",
  "tests/flow/builder-ui-source-contract.test.ts",
  "tests/flow/builder-command-registry.test.ts",
  "tests/flow/builder-accessibility.test.ts",
  "tests/flow/node-definitions.test.ts",
  "tests/flow/node-definition-runtime.test.ts",
  "tests/flow/node-definition-client-boundary.test.ts",
  "tests/flow/node-definition-ui.test.ts",
  "tests/flow/node-definition-adversarial.test.ts",
  "tests/flow/dryrun-enumeration.test.ts",
  "tests/flow/dryrun-gate.test.ts",
  "tests/flow/http-dryrun.test.ts",
  "tests/compat/manifest-v1.test.ts",
  "tests/compat",
  "tests/manifest",
  "tests/projects/hash.test.ts",
  "tests/projects/ui-source-contract.test.ts",
  "tests/projects/ui-contract.test.ts",
  "tests/api-flow-validation.test.ts",
  "tests/scripts/verification-env.test.ts",
  "tests/scripts/verify-phase1.test.ts",
  "tests/scripts/verify-phase2a.test.ts",
  "tests/scripts/verify-phase2b.test.ts",
]);

function commandStep(args) {
  return Object.freeze({
    kind: "command",
    command: "npm",
    args: Object.freeze(args),
  });
}

export const PHASE2B_STEPS = Object.freeze([
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

export function runPhase2bVerification(options = {}) {
  return runPhase1Verification({
    ...options,
    phaseLabel: "Phase 2B",
    steps: options.steps ?? PHASE2B_STEPS,
  });
}
