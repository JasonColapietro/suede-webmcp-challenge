import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const libraryFile = resolve(process.cwd(), "scripts/verify-phase-4a-lib.mjs");
const wrapperFile = resolve(process.cwd(), "scripts/verify-phase-4a.mjs");

type VerificationStep =
  | { readonly kind: "command"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "remove"; readonly path: string };

async function loadLibrary() {
  const specifier = `../../scripts/verify-phase-4a-lib.mjs?test=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ specifier) as Promise<{
    PHASE4A_STEPS: readonly VerificationStep[];
    createPhase4aIsolatedEnvironment(base?: NodeJS.ProcessEnv, root?: string): {
      directory: string;
      environment: NodeJS.ProcessEnv;
      cleanup(): void;
    };
    runPhase4aVerification(options?: Record<string, unknown>): void;
  }>;
}

function printableSteps(steps: readonly VerificationStep[]) {
  return steps.map((step) =>
    step.kind === "remove" ? `remove:${step.path}` : [step.command, ...step.args].join(" "),
  );
}

const evidence = () => ({ commit: "commit-4a", tree: "tree-4a", dirty: false });
const lock = () => ({ release: vi.fn() });

describe("Phase 4A local connections release verifier", () => {
  it("ships an import-safe library and executable wrapper", () => {
    expect(existsSync(libraryFile)).toBe(true);
    expect(existsSync(wrapperFile)).toBe(true);
    const wrapper = readFileSync(wrapperFile, "utf8");
    expect(wrapper).toContain("runPhase4aVerification");
    expect(wrapper).not.toMatch(/spawn|worker|vercel|https?:/iu);
  });

  it("freezes exactly five serial connection, runtime, API, UI, compatibility, prior-law, SDK, cleanup, and Next steps", async () => {
    const { PHASE4A_STEPS } = await loadLibrary();
    const printable = printableSteps(PHASE4A_STEPS);
    expect(printable).toHaveLength(5);
    expect(printable[0]).toMatch(/^npm test -- --testTimeout=15000 --maxWorkers=1 --minWorkers=1 /u);
    for (const target of [
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
    ]) expect(printable[0], target).toContain(target);
    expect(printable[1]).toBe("npm test -- --testTimeout=15000 --maxWorkers=1 --minWorkers=1");
    expect(printable[2]).toBe("npm run build --workspace=@suedeai/agents");
    expect(printable[3]).toBe("remove:.next");
    expect(printable[4]).toBe("npm run build");
    expect(PHASE4A_STEPS.every((step) => Object.isFrozen(step))).toBe(true);
    expect(PHASE4A_STEPS.every((step) => step.kind === "remove" || Object.isFrozen(step.args))).toBe(true);
  });

  it("inherits Phase 3A isolation before stripping every connection and cron value and generating fresh unprinted keys", async () => {
    const source = readFileSync(libraryFile, "utf8");
    expect(source).toMatch(/createPhase3aIsolatedEnvironment\([^)]*\)/u);
    const { createPhase4aIsolatedEnvironment, runPhase4aVerification } = await loadLibrary();
    const poison = {
      DURABLE_FUTURE_POISON: "durable-production",
      RUNTIME_IDEMPOTENCY_HMAC_KEY: "weak-runtime",
      CONNECTION_ENCRYPTION_KEY: "production-connection",
      CONNECTION_FUTURE_POISON: "future-connection",
      CRON_SECRET: "production-cron",
      DATABASE_URL: "postgres://production",
      OPENAI_API_KEY: "paid-provider",
      VERCEL_TOKEN: "deploy",
      X402_PRIVATE_KEY: "wallet",
    } as unknown as NodeJS.ProcessEnv;
    const first = createPhase4aIsolatedEnvironment(poison);
    const second = createPhase4aIsolatedEnvironment(poison);
    try {
      for (const isolated of [first, second]) {
        expect(isolated.environment).toMatchObject({
          DB_DRIVER: "sqlite",
          DURABLE_FUTURE_POISON: "",
          CONNECTION_FUTURE_POISON: "",
          DATABASE_URL: "",
          OPENAI_API_KEY: "",
          VERCEL_TOKEN: "",
          X402_PRIVATE_KEY: "",
        });
        expect(isolated.environment.SQLITE_PATH).toContain(isolated.directory);
        expect(isolated.environment.RUNTIME_IDEMPOTENCY_HMAC_KEY).toMatch(/^[0-9a-f]{64}$/u);
        expect(isolated.environment.CONNECTION_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/u);
        expect(isolated.environment.CRON_SECRET).toMatch(/^[0-9a-f]{64}$/u);
        expect(isolated.environment.CONNECTION_ENCRYPTION_KEY).not.toBe(isolated.environment.CRON_SECRET);
      }
      expect(first.environment.CONNECTION_ENCRYPTION_KEY).not.toBe(second.environment.CONNECTION_ENCRYPTION_KEY);
      expect(first.environment.CRON_SECRET).not.toBe(second.environment.CRON_SECRET);
    } finally { first.cleanup(); second.cleanup(); }

    const output: string[] = [];
    let connectionKey = "";
    let cronKey = "";
    runPhase4aVerification({
      steps: [], requireEvidence: evidence, acquireLock: lock, assertEvidence: vi.fn(),
      snapshotDefaultDatabase: () => ({ files: [] }), assertDefaultDatabaseUnchanged: vi.fn(),
      createEnvironment: (base: NodeJS.ProcessEnv, root: string) => {
        const isolated = createPhase4aIsolatedEnvironment(base, root);
        connectionKey = isolated.environment.CONNECTION_ENCRYPTION_KEY!;
        cronKey = isolated.environment.CRON_SECRET!;
        return isolated;
      },
      stdout: { write: (value: string) => { output.push(value); } },
    });
    expect(connectionKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(cronKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(output.join("")).not.toContain(connectionKey);
    expect(output.join("")).not.toContain(cronKey);
  });

  it("wraps Phase 3A clean evidence, lock, default database, ordered execution, and aggregate cleanup laws", async () => {
    const { runPhase4aVerification } = await loadLibrary();
    const events: string[] = [];
    runPhase4aVerification({
      requireEvidence: () => { events.push("git:before"); return evidence(); },
      acquireLock: () => { events.push("lock:acquire"); return { release: () => events.push("lock:release") }; },
      assertEvidence: () => events.push("git:after"),
      snapshotDefaultDatabase: () => { events.push("db:before"); return { files: [] }; },
      assertDefaultDatabaseUnchanged: () => events.push("db:after"),
      createEnvironment: () => ({ environment: {}, cleanup: () => events.push("cleanup") }),
      spawn: (command: string, args: readonly string[]) => { events.push([command, ...args].join(" ")); return { status: 0 }; },
      removeNext: () => events.push("remove:.next"), stdout: { write: vi.fn() }, npmCommand: "npm",
    });
    expect(events).toEqual([
      "git:before", "lock:acquire", "db:before",
      expect.stringMatching(/^npm test -- --testTimeout=15000 --maxWorkers=1 --minWorkers=1 /u),
      "npm test -- --testTimeout=15000 --maxWorkers=1 --minWorkers=1",
      "npm run build --workspace=@suedeai/agents", "remove:.next", "npm run build",
      "db:after", "git:after", "cleanup", "lock:release",
    ]);

    const output: string[] = [];
    runPhase4aVerification({
      steps: [], requireEvidence: evidence, acquireLock: lock, assertEvidence: vi.fn(),
      snapshotDefaultDatabase: () => ({ files: [] }), assertDefaultDatabaseUnchanged: vi.fn(),
      createEnvironment: () => ({ environment: {}, cleanup: vi.fn() }),
      stdout: { write: (value: string) => { output.push(value); } },
    });
    expect(output.join("")).toContain("Phase 4A local connections verification commit: commit-4a");
    expect(output.join("")).toContain("Phase 4A local connections verification tree: tree-4a");

    let thrown: unknown;
    try {
      runPhase4aVerification({
        requireEvidence: evidence,
        acquireLock: () => ({ release: () => { throw new Error("lock cleanup failed"); } }),
        assertEvidence: () => { throw new Error("tree changed"); },
        snapshotDefaultDatabase: () => ({ files: [] }),
        assertDefaultDatabaseUnchanged: () => { throw new Error("default db changed"); },
        createEnvironment: () => ({ environment: {}, cleanup: () => { throw new Error("cleanup failed"); } }),
        spawn: () => ({ status: 37 }), stdout: { write: vi.fn() }, npmCommand: "npm",
      });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AggregateError);
    const failures = (thrown as AggregateError).errors.map(String).join("\n");
    expect(failures).toContain("exited 37");
    expect(failures).toContain("tree changed");
    expect(failures).toContain("default db changed");
    expect(failures).toContain("cleanup failed");
    expect(failures).toContain("lock cleanup failed");
  });

  it("contains no recursion, direct provider/payment/deploy/remote database, persistent worker, or non-loopback network command", async () => {
    const { PHASE4A_STEPS } = await loadLibrary();
    const commands = PHASE4A_STEPS.filter((step) => step.kind === "command");
    expect(commands.every((step) => step.command === "npm")).toBe(true);
    expect(commands.some((step) => step.args[0] === "run" && /^verify:phase/u.test(step.args[1] ?? ""))).toBe(false);
    const executable = commands.map((step) => [step.command, ...step.args].join(" ")).join("\n");
    expect(executable).not.toMatch(/npm run worker|run-runtime-worker\.mjs|\b(?:vercel|curl|wget|https?:|psql|supabase|db push|migration up|settle|payment)\b/iu);
    expect(executable).not.toMatch(/(?:^|\s)(?:ssh|nc|netcat|telnet)(?:\s|$)/imu);
  });
});
