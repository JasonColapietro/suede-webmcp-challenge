import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/*
 * Both budgets cover fresh `vite-node` process startup, not the migration race
 * itself — same startup cost, and the same reasoning, as the claim and version
 * suites that already spawn vite-node workers.
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

interface MigrateResult {
  readonly workerId: string;
  readonly applied: number;
  readonly distinctVersions: number;
}

function migrateProcess(
  path: string,
  workerId: string,
  readyPath: string,
  releasePath: string,
  busyTimeoutMs?: number,
): Promise<MigrateResult> {
  const child = spawn(
    join(process.cwd(), "node_modules/.bin/vite-node"),
    ["--config", "vitest.config.ts", "tests/db/migrate-process-worker.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MIGRATE_DB: path,
        MIGRATE_WORKER_ID: workerId,
        MIGRATE_READY_PATH: readyPath,
        MIGRATE_RELEASE_PATH: releasePath,
        ...(busyTimeoutMs === undefined ? {} : { MIGRATE_BUSY_TIMEOUT_MS: String(busyTimeoutMs) }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  child.once("close", () => children.delete(child));
  return new Promise<MigrateResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`migration process ${workerId} failed to start: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`migration process ${workerId} exited ${String(code)}: ${stderr || stdout}`));
        return;
      }
      // vite-node can intercept SIGTERM and exit 0 with empty stdout, so a bare
      // JSON.parse here would throw inside the listener and escape the promise.
      try { resolve(JSON.parse(stdout) as MigrateResult); }
      catch { reject(new Error(`migration process ${workerId} returned invalid output: ${stdout}; stderr: ${stderr}`)); }
    });
  });
}

async function waitForFiles(paths: readonly string[], timeoutMs = BARRIER_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) {
      const missing = paths.filter((path) => !existsSync(path));
      throw new Error(`migration processes did not reach barrier within ${timeoutMs}ms; missing: ${missing.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("concurrent SQLite migration", () => {
  /*
   * Next prerenders pages in parallel workers, and /agents reaches a route that
   * opens the local database, so a build runs this migrator from several OS
   * processes against one file at once. Reading the ledger outside a write
   * transaction let both processes see zero applied migrations and both try to
   * insert version 1, which surfaced as
   * "UNIQUE constraint failed: schema_migrations.version" and killed the build.
   */
  /*
   * Two callers, chosen because they fail differently:
   *
   * The first is every repository's real shape — a 5000ms wait, explicit in the
   * project/runtime repos and inherited from better-sqlite3's default `timeout`
   * in SqliteRepo, which is the one the build hit. Serialising the migrator is
   * what saves this one, and it is the case that reproduced the original crash.
   *
   * The second waits not at all, which is the only shape that pins down
   * runSqliteMigrations raising the lock timeout for the duration: serialisation
   * alone still refuses it instantly with SQLITE_BUSY. Verified to fail when
   * MIGRATION_LOCK_TIMEOUT_MS is not applied, so this case is load-bearing
   * rather than decorative — a 5000ms caller passes either way whenever a cold
   * migration fits inside its budget, which on an unloaded machine it does.
   */
  it.each([
    { label: "every repository's shape, a 5000ms wait", busyTimeoutMs: undefined },
    { label: "a caller unwilling to wait at all, busy_timeout = 0", busyTimeoutMs: 0 },
  ])("lets two processes migrate one fresh database without a duplicate ledger row — $label", async ({ busyTimeoutMs }) => {
    const root = mkdtempSync(join(tmpdir(), "suede-migrate-race-"));
    roots.push(root);
    const path = join(root, "studio.db");
    const releasePath = join(root, "release");
    const readyPaths = ["a", "b"].map((id) => join(root, `ready-${id}`));

    const workers = ["a", "b"].map((id, index) =>
      migrateProcess(path, id, readyPaths[index], releasePath, busyTimeoutMs));

    await waitForFiles(readyPaths);
    writeFileSync(releasePath, "go", "utf8");
    const results = await Promise.all(workers);

    // Both processes have to succeed. Before the fix the loser threw
    // SQLITE_CONSTRAINT_PRIMARYKEY and exited non-zero, so the await rejected.
    expect(results.map((result) => result.workerId).sort()).toEqual(["a", "b"]);

    // And the ledger has to be a clean set: one row per version, no duplicates
    // and no partially applied prefix.
    const db = new Database(path, { readonly: true });
    const ledger = db
      .prepare("SELECT COUNT(*) AS applied, COUNT(DISTINCT version) AS distinctVersions FROM schema_migrations")
      .get() as { applied: number; distinctVersions: number };
    db.close();
    expect(ledger.applied).toBe(ledger.distinctVersions);
    expect(ledger.applied).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.applied).toBe(ledger.applied);
      expect(result.distinctVersions).toBe(ledger.applied);
    }
  }, TEST_TIMEOUT_MS);
});
