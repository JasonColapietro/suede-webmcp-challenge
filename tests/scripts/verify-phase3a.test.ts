import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const libraryFile = resolve(process.cwd(), "scripts/verify-phase-3a-lib.mjs");
const wrapperFile = resolve(process.cwd(), "scripts/verify-phase-3a.mjs");

type VerificationStep =
  | { readonly kind: "command"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "remove"; readonly path: string };

async function loadLibrary() {
  const specifier = `../../scripts/verify-phase-3a-lib.mjs?test=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ specifier) as Promise<{
    PHASE3A_STEPS: readonly VerificationStep[];
    createPhase3aIsolatedEnvironment(base?: NodeJS.ProcessEnv, root?: string): {
      directory: string;
      environment: NodeJS.ProcessEnv;
      cleanup(): void;
    };
    runPhase3aVerification(options?: Record<string, unknown>): void;
  }>;
}

function printableSteps(steps: readonly VerificationStep[]) {
  return steps.map((step) =>
    step.kind === "remove" ? `remove:${step.path}` : [step.command, ...step.args].join(" "),
  );
}

const evidence = () => ({ commit: "commit-3a", tree: "tree-3a", dirty: false });
const lock = () => ({ release: vi.fn() });

describe("Phase 3A durable runtime release verifier", () => {
  it("ships an import-safe library, wrapper, script, and honest architecture docs", () => {
    expect(existsSync(libraryFile)).toBe(true);
    expect(existsSync(wrapperFile)).toBe(true);
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts["verify:phase3a"]).toBe("node scripts/verify-phase-3a.mjs");
    const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    const parity = readFileSync(resolve(process.cwd(), "docs/superpowers/specs/2026-07-10-open-core-parity-design.md"), "utf8");
    const guide = readFileSync(resolve(process.cwd(), "docs/architecture/durable-runtime.md"), "utf8");
    for (const source of [readme, parity, guide]) {
      expect(source).toContain("npm run verify:phase3a");
      expect(source).toContain("SQLite-only");
      expect(source).toContain("no-spend");
      expect(source).toMatch(/browser evidence is unavailable/i);
    }
    for (const claim of [
      "database-backed queue", "whole-run", "at-least-once", "fencing", "restart-safe resume",
      "immutable version", "Last-Event-ID", "RUNTIME_IDEMPOTENCY_HMAC_KEY", "Manual fault and UAT checklist",
    ]) expect(guide).toContain(claim);
    for (const nonclaim of [
      "universal exactly-once", "mid-graph checkpoint", "effectful", "always-on hosted worker", "production durability",
    ]) expect(guide).toContain(nonclaim);
    expect(readme).not.toMatch(/launches every flow|Every flow you ship/u);
    expect(readme).toContain("never defaults to `studio.db`");
    expect(parity).toContain("target architecture and roadmap, not a current product inventory");
    expect(parity).toContain("[Section 25A](#25a-phase-3a-current-verified-subset)");
    expect(guide).toContain("randomBytes(32)");
    expect(guide).toContain("writeFileSync");
    expect(guide).not.toContain("process.stdout.write");
    expect(guide).not.toContain("<shared strong secret");
    expect(guide).toContain("fingerprint the default `studio.db`, WAL, and SHM");
    expect(guide).toContain("known harmless webhook-trigger-only fixture");
    expect(guide).toContain("block or observe external network access");
    expect(readme).toMatch(/does not start a persistent or\s+production worker command/u);
    expect(guide).toContain("does not start a direct persistent or production worker command");
    for (const source of [readme, guide]) {
      expect(source).toContain("bounded local `run-runtime-worker.mjs` entrypoint smoke");
      expect(source).toContain("disposable SQLite");
      expect(source).toContain("force-cleaned");
    }
  });

  it("freezes exactly five serial durable, compatibility, prior-law, SDK, cleanup, and Next steps", async () => {
    const { PHASE3A_STEPS } = await loadLibrary();
    const printable = printableSteps(PHASE3A_STEPS);
    expect(printable).toHaveLength(5);
    expect(printable[0]).toMatch(/^npm test -- --testTimeout=15000 --maxWorkers=1 --minWorkers=1 /);
    for (const target of [
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
    ]) expect(printable[0], target).toContain(target);
    expect(printable[1]).toBe("npm test -- --testTimeout=15000 --maxWorkers=1 --minWorkers=1");
    expect(printable[2]).toBe("npm run build --workspace=@suedeai/agents");
    expect(printable[3]).toBe("remove:.next");
    expect(printable[4]).toBe("npm run build");
    expect(PHASE3A_STEPS.every((step) => Object.isFrozen(step))).toBe(true);
    expect(PHASE3A_STEPS.every((step) => step.kind === "remove" || Object.isFrozen(step.args))).toBe(true);
  });

  it("creates fresh strong unprinted HMAC keys and strips inherited durable/provider/payment/deploy/db state", async () => {
    const { createPhase3aIsolatedEnvironment } = await loadLibrary();
    const poison = {
      DURABLE_CLAIM_DB: "/production/claim.db",
      DURABLE_WORKER_ID: "production-worker",
      DURABLE_READY_PATH: "/production/ready",
      DURABLE_RELEASE_PATH: "/production/release",
      DURABLE_FUTURE_POISON: "future",
      RUNTIME_IDEMPOTENCY_HMAC_KEY: "weak-production-key",
      DATABASE_URL: "postgres://production",
      SUPABASE_URL: "https://production.invalid",
      ANTHROPIC_API_KEY: "paid-provider",
      STRIPE_SECRET_KEY: "paid",
      VERCEL_TOKEN: "deploy",
      X402_PRIVATE_KEY: "wallet",
    } as unknown as NodeJS.ProcessEnv;
    const first = createPhase3aIsolatedEnvironment(poison);
    const second = createPhase3aIsolatedEnvironment(poison);
    try {
      for (const isolated of [first, second]) {
        expect(isolated.environment).toMatchObject({
          DB_DRIVER: "sqlite", DATABASE_URL: "", SUPABASE_URL: "", ANTHROPIC_API_KEY: "",
          STRIPE_SECRET_KEY: "", VERCEL_TOKEN: "", X402_PRIVATE_KEY: "", DURABLE_CLAIM_DB: "",
          DURABLE_WORKER_ID: "", DURABLE_READY_PATH: "",
          DURABLE_RELEASE_PATH: "", DURABLE_FUTURE_POISON: "",
        });
        expect(isolated.environment.SQLITE_PATH).toContain(isolated.directory);
        expect(isolated.environment.RUNTIME_IDEMPOTENCY_HMAC_KEY).toMatch(/^[0-9a-f]{64,}$/);
        expect(Buffer.from(isolated.environment.RUNTIME_IDEMPOTENCY_HMAC_KEY!, "hex").byteLength).toBeGreaterThanOrEqual(32);
        const testChild = { ...isolated.environment, DURABLE_CLAIM_DB: "/tmp/test.db", DURABLE_WORKER_ID: "test-worker" };
        expect(testChild).toMatchObject({ DURABLE_CLAIM_DB: "/tmp/test.db", DURABLE_WORKER_ID: "test-worker" });
      }
      expect(first.environment.RUNTIME_IDEMPOTENCY_HMAC_KEY).not.toBe(second.environment.RUNTIME_IDEMPOTENCY_HMAC_KEY);
    } finally { first.cleanup(); second.cleanup(); }

    const output: string[] = []; let generatedKey = "";
    const { runPhase3aVerification } = await loadLibrary();
    runPhase3aVerification({
      steps: [], requireEvidence: evidence, acquireLock: lock, assertEvidence: vi.fn(),
      snapshotDefaultDatabase: () => ({ files: [] }), assertDefaultDatabaseUnchanged: vi.fn(),
      createEnvironment: (base: NodeJS.ProcessEnv, root: string) => {
        const isolated = createPhase3aIsolatedEnvironment(base, root);
        generatedKey = isolated.environment.RUNTIME_IDEMPOTENCY_HMAC_KEY!;
        return isolated;
      },
      stdout: { write: (value: string) => { output.push(value); } },
    });
    expect(generatedKey).toMatch(/^[0-9a-f]{64,}$/);
    expect(output.join("")).not.toContain(generatedKey);
  });

  it("inherits exact clean evidence, lock, database fingerprint, ordered execution, and aggregate cleanup", async () => {
    const { runPhase3aVerification } = await loadLibrary();
    const events: string[] = [];
    const output: string[] = [];
    runPhase3aVerification({
      requireEvidence: () => { events.push("git:before"); return evidence(); },
      acquireLock: () => { events.push("lock:acquire"); return { release: () => events.push("lock:release") }; },
      assertEvidence: () => events.push("git:after"),
      snapshotDefaultDatabase: () => { events.push("db:before"); return { files: [] }; },
      assertDefaultDatabaseUnchanged: () => events.push("db:after"),
      createEnvironment: () => ({ environment: { DB_DRIVER: "sqlite", RUNTIME_IDEMPOTENCY_HMAC_KEY: "a".repeat(64) }, cleanup: () => events.push("cleanup") }),
      spawn: (command: string, args: readonly string[]) => { events.push([command, ...args].join(" ")); return { status: 0 }; },
      removeNext: () => events.push("remove:.next"),
      stdout: { write: (value: string) => { output.push(value); } }, npmCommand: "npm",
    });
    expect(events).toEqual([
      "git:before", "lock:acquire", "db:before",
      expect.stringMatching(/^npm test -- --testTimeout=15000 --maxWorkers=1 --minWorkers=1 /),
      "npm test -- --testTimeout=15000 --maxWorkers=1 --minWorkers=1",
      "npm run build --workspace=@suedeai/agents", "remove:.next", "npm run build",
      "db:after", "git:after", "cleanup", "lock:release",
    ]);
    expect(output.join("")).toContain("Phase 3A durable runtime verification commit: commit-3a");
    expect(output.join("")).toContain("Phase 3A durable runtime verification tree: tree-3a");

    let thrown: unknown;
    try {
      runPhase3aVerification({
        requireEvidence: evidence, acquireLock: () => ({ release: () => { throw new Error("lock cleanup failed"); } }),
        assertEvidence: () => { throw new Error("tree changed"); },
        snapshotDefaultDatabase: () => ({ files: [] }),
        assertDefaultDatabaseUnchanged: () => { throw new Error("default db changed"); },
        createEnvironment: () => ({ environment: {}, cleanup: () => { throw new Error("cleanup failed"); } }),
        spawn: () => ({ status: 37 }), stdout: { write: vi.fn() }, npmCommand: "npm",
      });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AggregateError);
    const failures = (thrown as AggregateError).errors.map(String).join("\n");
    expect(failures).toContain("exited 37"); expect(failures).toContain("tree changed");
    expect(failures).toContain("default db changed"); expect(failures).toContain("cleanup failed");
    expect(failures).toContain("lock cleanup failed");
  });

  it("contains no recursive verifier or direct persistent worker, network, provider, payment, database apply, or deploy command", async () => {
    const { PHASE3A_STEPS } = await loadLibrary();
    const commandSteps = PHASE3A_STEPS.filter((step) => step.kind === "command");
    const executableSurface = commandSteps.map((step) => [step.command, ...step.args].join(" ")).join("\n");
    expect(executableSurface).not.toContain("verify:phase3a");
    expect(executableSurface).not.toMatch(/npm run worker|run-runtime-worker\.mjs|\b(?:vercel|deploy|curl|wget|https?:|psql|supabase|db push|migration up|settle|payment|provider)\b/i);
    expect(commandSteps.every((step) => step.command === "npm")).toBe(true);
    const wrapper = readFileSync(wrapperFile, "utf8");
    expect(wrapper).toContain("runPhase3aVerification");
    expect(wrapper).not.toMatch(/spawn|worker|vercel|https?:/i);
  });
});
