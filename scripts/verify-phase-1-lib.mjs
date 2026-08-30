import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertGitEvidenceUnchanged,
  requireCleanGitEvidence,
} from "./git-evidence.mjs";
import { createIsolatedSqliteEnvironment } from "./verification-env.mjs";

const PHASE1_TEST_TARGETS = Object.freeze([
  "tests/db/migrations.test.ts",
  "tests/db/project-migration.test.ts",
  "tests/db/deployment-migration.test.ts",
  "tests/db/phase1-supabase-migration.test.ts",
  "tests/projects",
  "tests/api-projects-v2.test.ts",
  "tests/api-versions-v2.test.ts",
  "tests/manifest",
  "tests/compat",
  "tests/phase1/uat.test.ts",
  "tests/scripts/verify-phase1.test.ts",
  "packages/agent-kit/tests",
]);

function commandStep(args) {
  return Object.freeze({ kind: "command", command: "npm", args: Object.freeze(args) });
}

export const PHASE1_STEPS = Object.freeze([
  commandStep(["run", "verify:phase0"]),
  commandStep([
      "test",
      "--",
      "--testTimeout=10000",
      "--maxWorkers=1",
      "--minWorkers=1",
      ...PHASE1_TEST_TARGETS,
    ]),
  commandStep(["run", "build", "--workspace=@suedeai/agents"]),
  Object.freeze({ kind: "remove", path: ".next" }),
  commandStep(["run", "build"]),
]);

const DEFAULT_DATABASE_FILES = ["studio.db", "studio.db-wal", "studio.db-shm"];

function fileEvidence(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(file);
    let resolvedEvidence;
    try {
      const resolvedTarget = realpathSync(file);
      const targetStat = lstatSync(resolvedTarget);
      resolvedEvidence = targetStat.isFile()
        ? {
            kind: "file",
            size: targetStat.size,
            modifiedAt: targetStat.mtimeMs,
            changedAt: targetStat.ctimeMs,
            sha256: createHash("sha256").update(readFileSync(resolvedTarget)).digest("hex"),
          }
        : { kind: "non-file", mode: targetStat.mode };
    } catch (error) {
      resolvedEvidence = {
        kind: "unresolved",
        code:
          error !== null && typeof error === "object" && "code" in error
            ? String(error.code)
            : "unknown",
      };
    }
    return {
      exists: true,
      kind: "symlink",
      mode: stat.mode,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      changedAt: stat.ctimeMs,
      target,
      linkSha256: createHash("sha256").update(target, "utf8").digest("hex"),
      resolvedEvidence,
    };
  }
  if (!stat.isFile()) {
    return {
      exists: true,
      kind: "non-file",
      mode: stat.mode,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      changedAt: stat.ctimeMs,
    };
  }
  return {
    exists: true,
    kind: "file",
    mode: stat.mode,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    changedAt: stat.ctimeMs,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

function lockPath(projectRoot) {
  const digest = createHash("sha256").update(resolve(projectRoot), "utf8").digest("hex").slice(0, 24);
  return join(tmpdir(), `suede-phase1-verify-${digest}.lock`);
}

export function acquirePhase1VerificationLock(
  projectRoot = process.cwd(),
  options = {},
) {
  const file = lockPath(projectRoot);
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(file, "wx", 0o600);
      break;
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      let stale = false;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (Number.isInteger(parsed?.pid) && parsed.pid > 0) {
          try {
            process.kill(parsed.pid, 0);
          } catch (probeError) {
            stale =
              probeError !== null &&
              typeof probeError === "object" &&
              "code" in probeError &&
              probeError.code === "ESRCH";
          }
        }
      } catch {
        stale = false;
      }
      if (!stale || attempt > 0) {
        throw new Error(`Phase 1 verification is already running for ${resolve(projectRoot)}`);
      }
      unlinkSync(file);
    }
  }
  if (descriptor === undefined) throw new Error("Phase 1 verification lock could not be acquired");
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, projectRoot: resolve(projectRoot) }));
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(file);
    throw error;
  }
  let released = false;
  const signalHandlers = new Map();
  const exitHandler = () => release(false);
  const release = (removeHandlers = true) => {
    if (released) return;
    released = true;
    if (removeHandlers) {
      process.removeListener("exit", exitHandler);
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    }
    closeSync(descriptor);
    try {
      unlinkSync(file);
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  };
  if (options.handleSignals !== false) {
    process.once("exit", exitHandler);
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
      const handler = () => {
        release();
        process.kill(process.pid, signal);
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }
  return {
    release,
  };
}

export function snapshotDefaultDatabase(projectRoot = process.cwd()) {
  return {
    files: DEFAULT_DATABASE_FILES.map((name) => ({
      name,
      evidence: fileEvidence(resolve(projectRoot, name)),
    })),
  };
}

export function assertDefaultDatabaseUnchanged(before, projectRoot = process.cwd()) {
  const after = snapshotDefaultDatabase(projectRoot);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("default studio.db/WAL/SHM evidence changed during Phase 1 verification");
  }
  return after;
}

function commandError(command, args, result) {
  const printable = [command, ...args].join(" ");
  if (result?.error) return result.error;
  const error = new Error(`${printable} exited ${result?.status ?? "without a status"}`);
  error.exitCode = result?.status ?? 1;
  return error;
}

export function runPhase1Verification(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const requireEvidence = options.requireEvidence ?? requireCleanGitEvidence;
  const assertEvidence = options.assertEvidence ?? assertGitEvidenceUnchanged;
  const snapshotDatabase = options.snapshotDefaultDatabase ?? snapshotDefaultDatabase;
  const assertDatabase =
    options.assertDefaultDatabaseUnchanged ?? assertDefaultDatabaseUnchanged;
  const createEnvironment = options.createEnvironment ?? ((baseEnvironment, root) =>
    createIsolatedSqliteEnvironment(baseEnvironment, root));
  const spawn = options.spawn ?? spawnSync;
  const removeNext = options.removeNext ?? ((target) =>
    rmSync(resolve(projectRoot, target), { recursive: true, force: true }));
  const acquireLock = options.acquireLock ?? acquirePhase1VerificationLock;
  const npmCommand = options.npmCommand ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const steps = options.steps ?? PHASE1_STEPS;
  const phaseLabel = options.phaseLabel ?? "Phase 1";

  const evidence = requireEvidence();
  const lock = acquireLock(projectRoot);
  let databaseEvidence;
  let isolated;
  let failure;
  try {
    databaseEvidence = snapshotDatabase(projectRoot);
    isolated = createEnvironment(options.baseEnvironment ?? process.env, projectRoot);
    stdout.write(`${phaseLabel} verification commit: ${evidence.commit}\n`);
    stdout.write(`${phaseLabel} verification tree: ${evidence.tree}\n`);
    for (const step of steps) {
      if (step.kind === "remove") {
        removeNext(step.path);
        continue;
      }
      const command = step.command === "npm" ? npmCommand : step.command;
      const printable = [command, ...step.args].join(" ");
      stdout.write(`\n> ${printable}\n`);
      const result = spawn(command, [...step.args], {
        cwd: projectRoot,
        env: isolated.environment,
        stdio: "inherit",
      });
      if (result?.error || result?.status !== 0) throw commandError(command, step.args, result);
    }
  } catch (error) {
    failure = error;
  } finally {
    const finalizationErrors = [];
    if (databaseEvidence !== undefined) {
      try {
        assertDatabase(databaseEvidence, projectRoot);
      } catch (error) {
        finalizationErrors.push(error);
      }
    }
    try {
      assertEvidence(evidence);
    } catch (error) {
      finalizationErrors.push(error);
    }
    if (isolated !== undefined) {
      try {
        isolated.cleanup();
      } catch (error) {
        finalizationErrors.push(error);
      }
    }
    try {
      lock.release();
    } catch (error) {
      finalizationErrors.push(error);
    }
    if (finalizationErrors.length > 0) {
      failure = new AggregateError(
        failure === undefined ? finalizationErrors : [failure, ...finalizationErrors],
        failure instanceof Error ? failure.message : `${phaseLabel} final evidence failed`,
      );
    }
  }
  if (failure !== undefined) throw failure;
  stdout.write(`\n${phaseLabel} verification passed.\n`);
}
