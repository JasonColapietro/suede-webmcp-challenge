import { runPhase1Verification } from "./verify-phase-1-lib.mjs";

const FOCUSED_TARGETS = Object.freeze([
  "tests/flow/node-definitions.test.ts",
  "tests/flow/node-definition-runtime.test.ts",
  "tests/flow/node-definition-client-boundary.test.ts",
  "tests/flow/node-definition-ui.test.ts",
  "tests/flow/dryrun-enumeration.test.ts",
  "tests/flow/dryrun-gate.test.ts",
  "tests/flow/http-dryrun.test.ts",
  "tests/compat/manifest-v1.test.ts",
  "tests/manifest",
  "tests/flow",
  "tests/api-flow-validation.test.ts",
  "tests/guided",
  "tests/scripts/verify-phase1.test.ts",
  "tests/scripts/verify-phase2a.test.ts",
]);

function commandStep(args) {
  return Object.freeze({
    kind: "command",
    command: "npm",
    args: Object.freeze(args),
  });
}

export const PHASE2A_STEPS = Object.freeze([
  commandStep([
    "test",
    "--",
    "--testTimeout=10000",
    "--maxWorkers=1",
    "--minWorkers=1",
    ...FOCUSED_TARGETS,
  ]),
  commandStep([
    "test",
    "--",
    "--testTimeout=10000",
    "--maxWorkers=1",
    "--minWorkers=1",
  ]),
  commandStep(["run", "build", "--workspace=@suedeai/agents"]),
  Object.freeze({ kind: "remove", path: ".next" }),
  commandStep(["run", "build"]),
]);

export function runPhase2aVerification(options = {}) {
  return runPhase1Verification({
    ...options,
    phaseLabel: "Phase 2A",
    steps: options.steps ?? PHASE2A_STEPS,
  });
}
