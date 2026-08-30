import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const WORKER_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 75_000;
const roots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();
const defaultPath = resolve("studio.db");
const defaultBytes = existsSync(defaultPath) ? readFileSync(defaultPath) : null;
const baseEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && (key === "PATH" || key === "NODE_OPTIONS" || key.startsWith("SUEDE_PHASE4B1_"))) {
    baseEnv[key] = value;
  }
}

interface WorkerResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

interface WorkerProcess {
  readonly child: ReturnType<typeof spawn>;
  readonly result: Promise<WorkerResult>;
  readonly stderr: () => string;
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    // Assigned only on the path that reaches the kill; `done` runs before that
    // on the already-exited early return, so the declaration cannot merge with
    // the assignment.
    // eslint-disable-next-line prefer-const
    let force: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (force) clearTimeout(force);
      resolveStop();
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

function startWorker(env: NodeJS.ProcessEnv): WorkerProcess {
  const child = spawn(process.execPath, [resolve("scripts/run-runtime-worker.mjs")], {
    cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("close", () => children.delete(child));
  const result = new Promise<WorkerResult>((resolveResult, reject) => {
    child.once("error", (error) => reject(new Error(`worker entrypoint failed to start: ${error.message}`)));
    child.once("close", (code, signal) => resolveResult({ code, signal, stderr }));
  });
  return { child, result, stderr: () => stderr };
}

async function waitForReadiness(worker: WorkerProcess, readyPath: string, deadline: number): Promise<void> {
  let poll: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const remaining = Math.max(1, deadline - Date.now());
  const readiness = new Promise<void>((resolveReady, reject) => {
    const check = () => {
      if (!existsSync(readyPath)) return;
      if (poll) clearInterval(poll);
      if (timeout) clearTimeout(timeout);
      resolveReady();
    };
    poll = setInterval(check, 25);
    timeout = setTimeout(() => reject(new Error(
      `worker entrypoint did not become ready within ${WORKER_TIMEOUT_MS}ms at ${readyPath}: ${worker.stderr()}`,
    )), remaining);
    check();
  });
  const earlyExit = worker.result.then(
    ({ code, signal, stderr }) => { throw new Error(
      `worker entrypoint exited before readiness (code ${String(code)}, signal ${String(signal)}): ${stderr || "no stderr"}`,
    ); },
    (error: unknown) => { throw error instanceof Error ? error : new Error(String(error)); },
  );
  try {
    await Promise.race([readiness, earlyExit]);
  } finally {
    if (poll) clearInterval(poll);
    if (timeout) clearTimeout(timeout);
  }
}

async function resultBeforeDeadline(worker: WorkerProcess, deadline: number): Promise<WorkerResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const remaining = Math.max(1, deadline - Date.now());
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(
      `worker entrypoint timed out after ${WORKER_TIMEOUT_MS}ms: ${worker.stderr()}`,
    )), remaining);
  });
  try {
    return await Promise.race([worker.result, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function run(
  env: NodeJS.ProcessEnv,
  stopAfterMs?: number,
  readyPath?: string,
): Promise<{ code: number | null; stderr: string }> {
  const worker = startWorker(env);
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (readyPath !== undefined) {
      await waitForReadiness(worker, readyPath, deadline);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGTERM");
    } else if (stopAfterMs !== undefined) {
      stopTimer = setTimeout(() => worker.child.kill("SIGTERM"), stopAfterMs);
    }
    const result = await resultBeforeDeadline(worker, deadline);
    return { code: result.code, stderr: result.stderr };
  } catch (error) {
    await stopChild(worker.child);
    throw error;
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
  }
}

describe("local durable worker entrypoint", () => {
  it("terminates a parked child before removing disposable fixtures", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
    children.add(child);
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });

    await stopChild(child);

    expect(child.signalCode === "SIGTERM" || child.signalCode === "SIGKILL").toBe(true);
  });

  it("preserves verifier sentinels without inheriting external authority", () => {
    for (const [key, value] of Object.entries(process.env)) {
      if (key === "NODE_OPTIONS" || key.startsWith("SUEDE_PHASE4B1_")) {
        expect(baseEnv[key], key).toBe(value);
      }
    }
    for (const key of [
      "OPENAI_API_KEY", "STRIPE_SECRET_KEY", "VERCEL_TOKEN", "DATABASE_URL",
      "PLAYWRIGHT_BROWSERS_PATH", "SELENIUM_REMOTE_URL", "X402_PRIVATE_KEY",
    ]) expect(baseEnv[key], key).toBeUndefined();
  });

  it("reports worker stderr when the process exits before readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "worker-entry-early-exit-")); roots.push(root);
    const readyPath = join(root, "never-ready.sqlite");

    await expect(run(
      { ...baseEnv, RUNTIME_IDEMPOTENCY_HMAC_KEY: "0123456789abcdefZYXWVUTSRQPONMLK" },
      undefined,
      readyPath,
    )).rejects.toThrow(/exited before readiness[\s\S]*SQLITE_PATH/u);
  }, TEST_TIMEOUT_MS);

  it("starts and gracefully stops against only an explicit disposable absolute SQLite path", async () => {
    const root = mkdtempSync(join(tmpdir(), "worker-entry-")); roots.push(root);
    const path = join(root, "runtime.sqlite");
    const result = await run({ ...baseEnv, SQLITE_PATH: path, RUNTIME_IDEMPOTENCY_HMAC_KEY: "0123456789abcdefZYXWVUTSRQPONMLK" }, undefined, path);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(defaultPath)).toBe(defaultBytes !== null);
    if (defaultBytes) expect(readFileSync(defaultPath).equals(defaultBytes)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("fails closed for missing or relative database paths and weak keys", async () => {
    const missing = await run({ ...baseEnv, RUNTIME_IDEMPOTENCY_HMAC_KEY: "0123456789abcdefZYXWVUTSRQPONMLK" });
    expect(missing.code).not.toBe(0); expect(missing.stderr).toMatch(/SQLITE_PATH/);
    const relative = await run({ ...baseEnv, SQLITE_PATH: "studio.db", RUNTIME_IDEMPOTENCY_HMAC_KEY: "weak" });
    expect(relative.code).not.toBe(0); expect(relative.stderr).toMatch(/SQLITE_PATH|HMAC/);
    expect(existsSync(defaultPath)).toBe(defaultBytes !== null);
    if (defaultBytes) expect(readFileSync(defaultPath).equals(defaultBytes)).toBe(true);
  }, TEST_TIMEOUT_MS);
});
