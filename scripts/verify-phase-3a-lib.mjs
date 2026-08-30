import { randomBytes } from "node:crypto";
import { runPhase1Verification } from "./verify-phase-1-lib.mjs";
import { createIsolatedSqliteEnvironment } from "./verification-env.mjs";

const FOCUSED_TARGETS = Object.freeze([
  "tests/db/durable-runtime-migration.test.ts",
  "tests/db/durable-invocation-migration.test.ts",
  "tests/db/durable-event-usage-migration.test.ts",
  "tests/db/migrations.test.ts",
  "tests/db/project-migration.test.ts",
  "tests/db/workbook-tabs-migration.test.ts",
  "tests/runtime",
  "tests/flow/engine.test.ts",
  "tests/flow/engine-v2.test.ts",
  "tests/api-flow-run-preflight.test.ts",
  "tests/api-flow-lifecycle.test.ts",
  "tests/api-durable-runs-v3.test.ts",
  "tests/flow/run-dock-durable-lifecycle.test.tsx",
  "tests/flow/run-dock-durable-mode.test.tsx",
  "tests/flow/run-dock-durable-source-contract.test.ts",
  "tests/flow/run-dock-v2-run-route-source-contract.test.ts",
  "tests/flow/run-dock-scoped-mode.test.tsx",
  "tests/flow/run-dock-lifecycle.test.tsx",
  "tests/lib/auth.test.ts",
  "tests/compat",
  "tests/scripts/verification-env.test.ts",
  "tests/scripts/vitest-sqlite-isolation.test.ts",
  "tests/scripts/verify-phase1.test.ts",
  "tests/scripts/verify-phase2a.test.ts",
  "tests/scripts/verify-phase2b.test.ts",
  "tests/scripts/verify-phase2c.test.ts",
  "tests/scripts/verify-phase2d.test.ts",
  "tests/scripts/verify-phase2d-subflows.test.ts",
  "tests/scripts/verify-phase2e.test.ts",
  "tests/scripts/verify-phase2f.test.ts",
  "tests/scripts/verify-phase3a.test.ts",
]);

function commandStep(args) {
  return Object.freeze({ kind: "command", command: "npm", args: Object.freeze(args) });
}

export const PHASE3A_STEPS = Object.freeze([
  commandStep([
    "test", "--", "--testTimeout=15000", "--maxWorkers=1", "--minWorkers=1",
    ...FOCUSED_TARGETS,
  ]),
  commandStep(["test", "--", "--testTimeout=15000", "--maxWorkers=1", "--minWorkers=1"]),
  commandStep(["run", "build", "--workspace=@suedeai/agents"]),
  Object.freeze({ kind: "remove", path: ".next" }),
  commandStep(["run", "build"]),
]);

export function createPhase3aIsolatedEnvironment(
  baseEnvironment = process.env,
  projectRoot = process.cwd(),
) {
  const isolated = createIsolatedSqliteEnvironment(baseEnvironment, projectRoot);
  try {
    for (const key of Object.keys(isolated.environment)) {
      if (key.startsWith("DURABLE_")) isolated.environment[key] = "";
    }
    // Tests that coordinate their own disposable child processes add DURABLE_*
    // values after this boundary. No caller-provided durable path or identity survives it.
    isolated.environment.RUNTIME_IDEMPOTENCY_HMAC_KEY = randomBytes(32).toString("hex");
    return isolated;
  } catch (error) {
    isolated.cleanup();
    throw error;
  }
}

export function runPhase3aVerification(options = {}) {
  return runPhase1Verification({
    ...options,
    phaseLabel: options.phaseLabel ?? "Phase 3A durable runtime",
    steps: options.steps ?? PHASE3A_STEPS,
    createEnvironment: options.createEnvironment ?? ((baseEnvironment, projectRoot) =>
      createPhase3aIsolatedEnvironment(baseEnvironment, projectRoot)),
  });
}
