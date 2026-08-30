import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const libraryFile = resolve(process.cwd(), "scripts/verify-phase-1-lib.mjs");
const acquireTestLock = () => ({ release: vi.fn() });

async function loadLibrary() {
  const specifier = `../../scripts/verify-phase-1-lib.mjs?test=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ specifier) as Promise<{
    PHASE1_STEPS: ReadonlyArray<
      | { readonly kind: "command"; readonly command: string; readonly args: readonly string[] }
      | { readonly kind: "remove"; readonly path: string }
    >;
    acquirePhase1VerificationLock(projectRoot?: string): { release(): void };
    snapshotDefaultDatabase(projectRoot?: string): unknown;
    assertDefaultDatabaseUnchanged(before: unknown, projectRoot?: string): unknown;
    runPhase1Verification(options?: Record<string, unknown>): void;
  }>;
}

describe("Phase 1 release verifier", () => {
  it("exists as an import-safe library before exposing the executable wrapper", () => {
    expect(existsSync(libraryFile)).toBe(true);
  });

  it("runs the accepted gates serially in release order", async () => {
    if (!existsSync(libraryFile)) return;
    const { runPhase1Verification } = await loadLibrary();
    const events: string[] = [];
    runPhase1Verification({
      requireEvidence: () => {
        events.push("git:before");
        return { commit: "commit", tree: "tree", dirty: false };
      },
      acquireLock: () => {
        events.push("lock:acquire");
        return { release: () => events.push("lock:release") };
      },
      assertEvidence: () => events.push("git:after"),
      snapshotDefaultDatabase: () => {
        events.push("db:before");
        return { files: [] };
      },
      assertDefaultDatabaseUnchanged: () => events.push("db:after"),
      createEnvironment: () => ({
        environment: { DB_DRIVER: "sqlite", X402_SKIP_SETTLEMENT: "true" },
        cleanup: () => events.push("cleanup"),
      }),
      spawn: (command: string, args: readonly string[]) => {
        events.push([command, ...args].join(" "));
        return { status: 0 };
      },
      removeNext: () => events.push("remove:.next"),
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      npmCommand: "npm",
    });

    expect(events).toEqual([
      "git:before",
      "lock:acquire",
      "db:before",
      "npm run verify:phase0",
      expect.stringMatching(/^npm test -- --testTimeout=10000 --maxWorkers=1 --minWorkers=1 /),
      "npm run build --workspace=@suedeai/agents",
      "remove:.next",
      "npm run build",
      "db:after",
      "git:after",
      "cleanup",
      "lock:release",
    ]);
  });

  it("refuses dirty evidence before creating an environment or running a command", async () => {
    if (!existsSync(libraryFile)) return;
    const { runPhase1Verification } = await loadLibrary();
    const spawn = vi.fn();
    const createEnvironment = vi.fn();
    expect(() =>
      runPhase1Verification({
        requireEvidence: () => {
          throw new Error("worktree must be clean");
        },
        createEnvironment,
        spawn,
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
      }),
    ).toThrow("worktree must be clean");
    expect(createEnvironment).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops at the first failed command but still proves evidence and cleans up", async () => {
    if (!existsSync(libraryFile)) return;
    const { runPhase1Verification } = await loadLibrary();
    const commands: string[] = [];
    const finalizers: string[] = [];
    expect(() =>
      runPhase1Verification({
        acquireLock: acquireTestLock,
        requireEvidence: () => ({ commit: "commit", tree: "tree", dirty: false }),
        assertEvidence: () => finalizers.push("git"),
        snapshotDefaultDatabase: () => ({ files: [] }),
        assertDefaultDatabaseUnchanged: () => finalizers.push("db"),
        createEnvironment: () => ({
          environment: { DB_DRIVER: "sqlite", X402_SKIP_SETTLEMENT: "true" },
          cleanup: () => finalizers.push("cleanup"),
        }),
        spawn: (command: string, args: readonly string[]) => {
          commands.push([command, ...args].join(" "));
          return { status: commands.length === 2 ? 19 : 0 };
        },
        removeNext: () => finalizers.push("remove"),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
        npmCommand: "npm",
      }),
    ).toThrow("exited 19");
    expect(commands).toHaveLength(2);
    expect(finalizers).toEqual(["db", "git", "cleanup"]);
  });

  it("passes stripped SQLite-only credentials to every command", async () => {
    if (!existsSync(libraryFile)) return;
    const { runPhase1Verification } = await loadLibrary();
    const environments: Array<Record<string, string | undefined>> = [];
    runPhase1Verification({
      acquireLock: acquireTestLock,
      requireEvidence: () => ({ commit: "commit", tree: "tree", dirty: false }),
      assertEvidence: vi.fn(),
      snapshotDefaultDatabase: () => ({ files: [] }),
      assertDefaultDatabaseUnchanged: vi.fn(),
      spawn: (_command: string, _args: readonly string[], options: { env: Record<string, string> }) => {
        environments.push(options.env);
        return { status: 0 };
      },
      removeNext: vi.fn(),
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      npmCommand: "npm",
      baseEnvironment: {
        HOME: "/poison/home",
        XDG_CONFIG_HOME: "/poison/config",
        XDG_CACHE_HOME: "/poison/cache",
        XDG_DATA_HOME: "/poison/data",
        SUPABASE_URL: "https://remote.example",
        SUPABASE_SERVICE_ROLE_KEY: "secret",
        DATABASE_URL: "postgres://remote",
        PGHOST: "remote.postgres.example",
        PGPASSFILE: "/poison/.pgpass",
        PGSERVICEFILE: "/poison/pg_service.conf",
        NODE_OPTIONS: "--require=/poison/provider.cjs",
        NEXT_TELEMETRY_DISABLED: "0",
        DO_NOT_TRACK: "0",
        BASH_ENV: "/poison/bash-env",
        AWS_ACCESS_KEY_ID: "provider-key",
        STRIPE_SECRET_KEY: "payment-key",
        X402_PRIVATE_KEY: "paid",
      },
    });

    expect(environments.length).toBeGreaterThan(0);
    for (const environment of environments) {
      expect(environment).toMatchObject({
        DB_DRIVER: "sqlite",
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        DATABASE_URL: "",
        X402_PRIVATE_KEY: "",
        X402_SKIP_SETTLEMENT: "true",
        PGHOST: "",
        PGPASSFILE: "",
        PGSERVICEFILE: "",
        NODE_OPTIONS: "",
        NEXT_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
        BASH_ENV: "",
        AWS_ACCESS_KEY_ID: "",
        STRIPE_SECRET_KEY: "",
      });
      expect(environment.HOME).not.toBe("/poison/home");
      expect(environment.XDG_CONFIG_HOME).toContain(environment.HOME!);
      expect(environment.XDG_CACHE_HOME).toContain(environment.HOME!);
      expect(environment.XDG_DATA_HOME).toContain(environment.HOME!);
    }
  });

  it("rejects a concurrent verifier through an OS-temp lock", async () => {
    if (!existsSync(libraryFile)) return;
    const { acquirePhase1VerificationLock } = await loadLibrary();
    const project = mkdtempSync(join(tmpdir(), "suede-phase1-lock-test-"));
    const first = acquirePhase1VerificationLock(project);
    try {
      expect(() => acquirePhase1VerificationLock(project)).toThrow("already running");
    } finally {
      first.release();
      rmSync(project, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "recovers the verifier lock after SIGTERM cleanup or a stale crashed owner",
    async () => {
      if (!existsSync(libraryFile)) return;
      const { acquirePhase1VerificationLock } = await loadLibrary();
      const moduleUrl = pathToFileURL(libraryFile).href;
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        const project = mkdtempSync(join(tmpdir(), `suede-phase1-${signal.toLowerCase()}-`));
        const child = spawnChild(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { acquirePhase1VerificationLock } from ${JSON.stringify(moduleUrl)};
             acquirePhase1VerificationLock(${JSON.stringify(project)});
             process.stdout.write("ready\\n");
             setInterval(() => {}, 1000);`,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        try {
          await new Promise<void>((resolveReady, rejectReady) => {
            const timeout = setTimeout(() => rejectReady(new Error("lock child did not start")), 5_000);
            child.stdout.setEncoding("utf8");
            child.stdout.once("data", (chunk) => {
              clearTimeout(timeout);
              if (String(chunk).includes("ready")) resolveReady();
              else rejectReady(new Error(`unexpected child output: ${String(chunk)}`));
            });
            child.once("error", rejectReady);
          });
          child.kill(signal);
          await once(child, "exit");
          const recovered = acquirePhase1VerificationLock(project);
          recovered.release();
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          rmSync(project, { recursive: true, force: true });
        }
      }
    },
  );

  it("detects changes behind a symlinked default studio database", async () => {
    if (!existsSync(libraryFile)) return;
    const { snapshotDefaultDatabase, assertDefaultDatabaseUnchanged } = await loadLibrary();
    const project = mkdtempSync(join(tmpdir(), "suede-phase1-db-evidence-"));
    const external = join(project, "external.db");
    writeFileSync(external, "before", "utf8");
    symlinkSync(external, join(project, "studio.db"));
    try {
      const before = snapshotDefaultDatabase(project);
      writeFileSync(external, "after", "utf8");
      expect(() => assertDefaultDatabaseUnchanged(before, project)).toThrow(
        "studio.db/WAL/SHM evidence changed",
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("records a dangling studio database symlink instead of treating it as absent", async () => {
    if (!existsSync(libraryFile)) return;
    const { snapshotDefaultDatabase } = await loadLibrary();
    const project = mkdtempSync(join(tmpdir(), "suede-phase1-dangling-db-"));
    symlinkSync(join(project, "missing.db"), join(project, "studio.db"));
    try {
      const snapshot = snapshotDefaultDatabase(project) as {
        files: Array<{
          name: string;
          evidence: {
            exists: boolean;
            kind?: string;
            linkSha256?: string;
            modifiedAt?: number;
            changedAt?: number;
          };
        }>;
      };
      const evidence = snapshot.files.find(({ name }) => name === "studio.db")?.evidence;
      expect(evidence).toMatchObject({ exists: true, kind: "symlink" });
      expect(evidence?.linkSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof evidence?.modifiedAt).toBe("number");
      expect(typeof evidence?.changedAt).toBe("number");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("preserves child, dirty-source, and cleanup failures together", async () => {
    if (!existsSync(libraryFile)) return;
    const { runPhase1Verification } = await loadLibrary();
    let thrown: unknown;
    try {
      runPhase1Verification({
        acquireLock: acquireTestLock,
        requireEvidence: () => ({ commit: "commit", tree: "tree", dirty: false }),
        assertEvidence: () => {
          throw new Error("source became dirty");
        },
        snapshotDefaultDatabase: () => ({ files: [] }),
        assertDefaultDatabaseUnchanged: vi.fn(),
        createEnvironment: () => ({
          environment: { DB_DRIVER: "sqlite", X402_SKIP_SETTLEMENT: "true" },
          cleanup: () => {
            throw new Error("cleanup failed");
          },
        }),
        spawn: () => ({ status: 23 }),
        stdout: { write: vi.fn() },
        npmCommand: "npm",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    const messages = (thrown as AggregateError).errors.map((error) => String(error));
    expect(messages.join("\n")).toContain("exited 23");
    expect(messages.join("\n")).toContain("source became dirty");
    expect(messages.join("\n")).toContain("cleanup failed");
  });

  it("short-circuits at every allowed child-command failure", async () => {
    if (!existsSync(libraryFile)) return;
    const { PHASE1_STEPS, runPhase1Verification } = await loadLibrary();
    const commandCount = PHASE1_STEPS.filter((step) => step.kind === "command").length;
    for (let failingCommand = 1; failingCommand <= commandCount; failingCommand += 1) {
      let calls = 0;
      expect(() =>
        runPhase1Verification({
          acquireLock: acquireTestLock,
          requireEvidence: () => ({ commit: "commit", tree: "tree", dirty: false }),
          assertEvidence: vi.fn(),
          snapshotDefaultDatabase: () => ({ files: [] }),
          assertDefaultDatabaseUnchanged: vi.fn(),
          createEnvironment: () => ({
            environment: { DB_DRIVER: "sqlite", X402_SKIP_SETTLEMENT: "true" },
            cleanup: vi.fn(),
          }),
          spawn: () => ({ status: ++calls === failingCommand ? 31 : 0 }),
          removeNext: vi.fn(),
          stdout: { write: vi.fn() },
          npmCommand: "npm",
        }),
      ).toThrow("exited 31");
      expect(calls).toBe(failingCommand);
    }
  });

  it("contains no Supabase, psql, remote, apply, launch, run, or settlement command", async () => {
    if (!existsSync(libraryFile)) return;
    const { PHASE1_STEPS } = await loadLibrary();
    const commandSteps = PHASE1_STEPS.filter((step) => step.kind === "command");
    const executableSurface = commandSteps
      .map((step) => [step.command, step.args[0], step.args[0] === "run" ? step.args[1] : ""].join(" "))
      .join("\n");
    const allArguments = commandSteps.flatMap((step) => step.args).join("\n");
    expect(executableSurface).not.toMatch(
      /supabase|psql|postgres|curl|https?:|\bapply\b|\blaunch\b|\bsettle|x402|\brun\b(?! build| verify)/i,
    );
    expect(allArguments).not.toMatch(/\.sql(?:\s|$)|https?:|verify:phase1/i);
    expect(Object.isFrozen(PHASE1_STEPS)).toBe(true);
    expect(PHASE1_STEPS.every((step) => Object.isFrozen(step))).toBe(true);
    expect(
      PHASE1_STEPS.every((step) => step.kind === "remove" || Object.isFrozen(step.args)),
    ).toBe(true);
  });
});
