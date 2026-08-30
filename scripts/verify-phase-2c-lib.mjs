import { runPhase1Verification } from "./verify-phase-1-lib.mjs";

const FOCUSED_TARGETS = Object.freeze([
  // Versioned graph contract and lossless codec.
  "tests/flow/api-contract.test.ts",
  "tests/flow/graph-v2-contract.test.ts",
  "tests/flow/graph-v2-codec.test.ts",
  // Canonical schemas and conservative typed connections.
  "tests/flow/node-definitions.test.ts",
  "tests/flow/node-definition-runtime.test.ts",
  "tests/flow/node-port-schemas.test.ts",
  "tests/flow/port-compatibility.test.ts",
  "tests/flow/typed-connection-integration.test.ts",
  // V1/v2 commands, history, persistence, and secret-safe fragments.
  "tests/flow/graph-command-contract.test.ts",
  "tests/flow/graph-command-reducer.test.ts",
  "tests/flow/graph-command-adversarial.test.ts",
  "tests/flow/graph-command-v2.test.ts",
  "tests/flow/graph-command-v2-adversarial.test.ts",
  "tests/flow/graph-fragment.test.ts",
  "tests/flow/graph-fragment-v2.test.ts",
  "tests/flow/graph-history.test.ts",
  "tests/flow/save-queue.test.ts",
  "tests/flow/builder-command-integration.test.ts",
  "tests/flow/builder-command-registry.test.ts",
  // Structured bindings and both runtime versions.
  "tests/flow/value-bindings.test.ts",
  "tests/flow/engine-v2.test.ts",
  "tests/flow/engine.test.ts",
  "tests/flow/loop-node.test.ts",
  "tests/api-flow-lifecycle.test.ts",
  "tests/db/sqlite-repo.test.ts",
  "tests/projects/sqlite-project-repo.test.ts",
  // Strict manifests, hashes, and all legacy compatibility contracts.
  "tests/manifest/v2-schema.test.ts",
  "tests/manifest/v2-roundtrip.test.ts",
  "tests/manifest",
  "tests/projects/hash-v2.test.ts",
  "tests/projects/hash.test.ts",
  "tests/compat",
  // Typed-data Studio behavior and accessible generic ports.
  "tests/flow/variable-ui-contract.test.ts",
  "tests/flow/binding-ui-contract.test.ts",
  "tests/flow/node-definition-ui.test.ts",
  "tests/flow/builder-accessibility.test.ts",
  "tests/flow/builder-ui-source-contract.test.ts",
  "tests/projects/ui-source-contract.test.ts",
  "tests/projects/ui-contract.test.ts",
  // Hardened environment/evidence runners, including this non-recursive gate.
  "tests/scripts/verification-env.test.ts",
  "tests/scripts/verify-phase1.test.ts",
  "tests/scripts/verify-phase2a.test.ts",
  "tests/scripts/verify-phase2b.test.ts",
  "tests/scripts/verify-phase2c.test.ts",
]);

function commandStep(args) {
  return Object.freeze({
    kind: "command",
    command: "npm",
    args: Object.freeze(args),
  });
}

export const PHASE2C_STEPS = Object.freeze([
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

export function runPhase2cVerification(options = {}) {
  return runPhase1Verification({
    ...options,
    phaseLabel: "Phase 2C",
    steps: options.steps ?? PHASE2C_STEPS,
  });
}
