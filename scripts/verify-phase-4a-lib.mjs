import { randomBytes } from "node:crypto";
import {
  createPhase3aIsolatedEnvironment,
  runPhase3aVerification,
} from "./verify-phase-3a-lib.mjs";

const FOCUSED_TARGETS = Object.freeze([
  "tests/db/connections-migration.test.ts",
  "tests/connections",
  "tests/runtime",
  "tests/api-connections-collection-v2.test.ts",
  "tests/api-connection-slots-v2.test.ts",
  "tests/api-agent-connection-live.test.ts",
  "tests/webhook-handler.test.ts",
  "tests/api-cron-connection-live.test.ts",
  "tests/api-cron-dryrun.test.ts",
  "tests/projects/live-execution.test.ts",
  "tests/flow/connection-secret-runtime.test.ts",
  "tests/flow/http-node.test.ts",
  "tests/flow/dryrun-enumeration.test.ts",
  "tests/flow/engine-v2.test.ts",
  "tests/flow/build-connection-source-contract.test.ts",
  "tests/flow/binding-ui-contract.test.ts",
  "tests/flow/graph-fragment.test.ts",
  "tests/flow/studio-recovery.test.ts",
  "tests/flow/typed-connection-integration.test.ts",
  "tests/components",
  "tests/manifest",
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

export const PHASE4A_STEPS = Object.freeze([
  commandStep([
    "test", "--", "--testTimeout=15000", "--maxWorkers=1", "--minWorkers=1",
    ...FOCUSED_TARGETS,
  ]),
  commandStep(["test", "--", "--testTimeout=15000", "--maxWorkers=1", "--minWorkers=1"]),
  commandStep(["run", "build", "--workspace=@suedeai/agents"]),
  Object.freeze({ kind: "remove", path: ".next" }),
  commandStep(["run", "build"]),
]);

function freshDistinctKey(excluded) {
  for (;;) {
    const value = randomBytes(32).toString("hex");
    if (!excluded.has(value)) return value;
  }
}

export function createPhase4aIsolatedEnvironment(
  baseEnvironment = process.env,
  projectRoot = process.cwd(),
) {
  const isolated = createPhase3aIsolatedEnvironment(baseEnvironment, projectRoot);
  try {
    for (const key of Object.keys(isolated.environment)) {
      if (key.startsWith("CONNECTION_") || key === "CRON_SECRET") {
        isolated.environment[key] = "";
      }
    }
    const excluded = new Set([
      baseEnvironment.CONNECTION_ENCRYPTION_KEY,
      baseEnvironment.CRON_SECRET,
      isolated.environment.RUNTIME_IDEMPOTENCY_HMAC_KEY,
    ].filter((value) => typeof value === "string" && value.length > 0));
    const connectionKey = freshDistinctKey(excluded);
    excluded.add(connectionKey);
    const cronKey = freshDistinctKey(excluded);
    isolated.environment.CONNECTION_ENCRYPTION_KEY = connectionKey;
    isolated.environment.CRON_SECRET = cronKey;
    return isolated;
  } catch (error) {
    isolated.cleanup();
    throw error;
  }
}

export function runPhase4aVerification(options = {}) {
  return runPhase3aVerification({
    ...options,
    phaseLabel: "Phase 4A local connections",
    steps: options.steps ?? PHASE4A_STEPS,
    createEnvironment: options.createEnvironment ?? ((baseEnvironment, projectRoot) =>
      createPhase4aIsolatedEnvironment(baseEnvironment, projectRoot)),
  });
}
