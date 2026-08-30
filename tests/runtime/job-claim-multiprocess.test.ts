import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInput, task3Fixture } from "./task3-fixture";

/*
 * Both budgets cover fresh `vite-node` process startup, not the claim race
 * itself. Each worker must transform the repo and runtime module graphs before
 * it can write its ready file, which on a saturated machine takes far longer
 * than the claim it is there to test — observed blowing a 30s barrier at 33.9s
 * with the box at load ~300. Same startup-cost problem #184 fixed in
 * version-service (4s -> 30s barrier, 20s -> 60s budget); these are that fix
 * applied to the other suite that spawns vite-node workers.
 *
 * No assertion is weakened by this: the test still spawns two real OS
 * processes against one database, still synchronises them on the barrier
 * files, and still asserts exactly one winner plus a single attempt and a
 * single job.claimed event read back from SQLite.
 */
const BARRIER_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;
const roots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    // Assigned only on the path that reaches the kill; `done` runs before that
    // on the already-exited early return, so the declaration cannot merge with
    // the assignment.
    // eslint-disable-next-line prefer-const
    let force: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (force) clearTimeout(force);
      resolve();
    };
    child.once("close", done);
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    child.kill("SIGTERM");
    force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1_000);
    force.unref();
  });
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface ClaimProcess {
  readonly workerId: string;
  readonly result: Promise<{ status: string }>;
}

function claimProcess(path: string, workerId: string, readyPath: string, releasePath: string): ClaimProcess {
  const child = spawn(join(process.cwd(), "node_modules/.bin/vite-node"), ["--config", "vitest.config.ts", "tests/runtime/job-claim-process-worker.ts"], {
    cwd: process.cwd(), env: { ...process.env, DURABLE_CLAIM_DB: path, DURABLE_WORKER_ID: workerId, DURABLE_READY_PATH: readyPath, DURABLE_RELEASE_PATH: releasePath }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  const result = new Promise<{ status: string }>((resolve, reject) => {
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`claim process ${workerId} failed to start: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(`claim process ${workerId} exited ${String(code)}: ${stderr || stdout}`)); return; }
      try { resolve(JSON.parse(stdout) as { status: string }); }
      catch { reject(new Error(`claim process ${workerId} returned invalid output: ${stdout}; stderr: ${stderr}`)); }
    });
  });
  return { workerId, result };
}

async function waitForFiles(
  paths: readonly string[],
  processes: readonly ClaimProcess[] = [],
  timeoutMs = BARRIER_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const barrier = async () => {
    while (!paths.every(existsSync)) {
      if (Date.now() >= deadline) {
        const missing = paths.filter((path) => !existsSync(path));
        throw new Error(`claim processes did not reach barrier within ${timeoutMs}ms; missing: ${missing.join(", ")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  if (processes.length === 0) {
    await barrier();
    return;
  }
  const earlyExit = Promise.race(processes.map(({ workerId, result }) => result.then(
    ({ status }) => { throw new Error(`claim process ${workerId} exited before barrier with status ${status}`); },
    (error: unknown) => { throw error instanceof Error ? error : new Error(`claim process ${workerId} failed: ${String(error)}`); },
  )));
  await Promise.race([barrier(), earlyExit]);
}

describe("multiprocess durable claim race", () => {
  it("terminates a parked child before removing test fixtures", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
    });
    children.add(child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    await stopChild(child);

    expect(child.signalCode === "SIGTERM" || child.signalCode === "SIGKILL").toBe(true);
  });

  it("reports a child startup failure instead of hiding it behind the barrier timeout", async () => {
    // The child failure is ALREADY rejected before waitForFiles is called, so
    // this asserts precedence rather than racing two timers. It previously
    // rejected on a 25ms timer against a 100ms barrier deadline: any stall
    // past 100ms (CPU contention on a loaded box) left both timers expired,
    // and Node then ran the barrier's earlier-scheduled 10ms poll first, so
    // the barrier timeout won and the test failed for a reason that had
    // nothing to do with the precedence being tested. A generous barrier
    // deadline plus an already-settled rejection makes the ordering total.
    const failed = Promise.reject(new Error("process-left failed: diagnostic stderr"));
    void failed.catch(() => undefined);

    await expect(waitForFiles(
      [join(process.cwd(), `missing-ready-${crypto.randomUUID()}`)],
      [{ workerId: "process-left", result: failed }],
      BARRIER_TIMEOUT_MS,
    )).rejects.toThrow("process-left failed: diagnostic stderr");
  }, 15_000);

  it("has exactly one winner across independent OS processes", async () => {
    const setup = task3Fixture(); roots.push(setup.root);
    await setup.repo.createExecution(createInput(1)); setup.repo.close();
    const leftReady = join(setup.root, "left.ready"); const rightReady = join(setup.root, "right.ready");
    const leftRelease = join(setup.root, "left.release"); const rightRelease = join(setup.root, "right.release");
    const pending = [claimProcess(setup.path, "process-left", leftReady, leftRelease), claimProcess(setup.path, "process-right", rightReady, rightRelease)];
    await waitForFiles([leftReady, rightReady], pending);
    writeFileSync(leftRelease, "go", "utf8"); writeFileSync(rightRelease, "go", "utf8");
    const results = await Promise.all(pending.map(({ result }) => result));
    expect(results.map((result) => result.status).sort()).toEqual(["claimed", "no-job"]);
    const db = new Database(setup.path);
    expect(db.prepare("SELECT count(*) AS count FROM execution_attempts").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM execution_events WHERE type = 'job.claimed'").get()).toEqual({ count: 1 });
    db.close();
  }, TEST_TIMEOUT_MS);
});
