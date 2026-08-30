import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  assertGitEvidenceUnchanged,
  requireCleanGitEvidence,
} from "./git-evidence.mjs";
import { createIsolatedSqliteEnvironment } from "./verification-env.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const isolated = createIsolatedSqliteEnvironment();

function run(command, args) {
  const printable = [command, ...args].join(" ");
  process.stdout.write(`\n> ${printable}\n`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: isolated.environment,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${printable} exited ${result.status}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

let passed = false;
try {
  const evidence = requireCleanGitEvidence();
  process.stdout.write(`Phase 0 verification commit: ${evidence.commit}\n`);
  process.stdout.write(`Phase 0 verification tree: ${evidence.tree}\n`);
  run(npm, ["test", "--", "--testTimeout=10000", "--maxWorkers=1", "--minWorkers=1"]);
  run(npm, ["run", "build", "--workspace=@suedeai/agents"]);
  rmSync(".next", { recursive: true, force: true });
  run(npm, ["run", "build"]);
  assertGitEvidenceUnchanged(evidence);
  passed = true;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nPhase 0 verification stopped: ${message}.\n`);
  process.exitCode =
    typeof error === "object" && error !== null && "exitCode" in error
      ? Number(error.exitCode)
      : 1;
} finally {
  isolated.cleanup();
}

if (passed) process.stdout.write("\nPhase 0 verification passed.\n");
