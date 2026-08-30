import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createIsolatedSqliteEnvironment } from "../../scripts/verification-env.mjs";

const libraryFile = resolve(process.cwd(), "scripts/verify-phase-2d-subflows-lib.mjs");
const wrapperFile = resolve(process.cwd(), "scripts/verify-phase-2d-subflows.mjs");

type VerificationStep =
  | { readonly kind: "command"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "remove"; readonly path: string };

async function loadLibrary() {
  const specifier = `../../scripts/verify-phase-2d-subflows-lib.mjs?test=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ specifier) as Promise<{
    PHASE2D_SUBFLOW_STEPS: readonly VerificationStep[];
    runPhase2dSubflowVerification(options?: Record<string, unknown>): void;
  }>;
}

function printableSteps(steps: readonly VerificationStep[]) {
  return steps.map((step) =>
    step.kind === "remove" ? `remove:${step.path}` : [step.command, ...step.args].join(" "),
  );
}

describe("Phase 2D reusable-subflow release verifier", () => {
  it("ships an import-safe library and executable wrapper", () => {
    expect(existsSync(libraryFile)).toBe(true);
    expect(existsSync(wrapperFile)).toBe(true);
  });

  it("documents a separate local no-spend subflow gate", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    const spec = readFileSync(
      resolve(
        process.cwd(),
        "docs/superpowers/specs/2026-07-10-phase-2-best-in-class-builder-design.md",
      ),
      "utf8",
    );
    const guide = readFileSync(
      resolve(process.cwd(), "docs/architecture/typed-reusable-subflows.md"),
      "utf8",
    );

    expect(packageJson.scripts["verify:phase2d:subflows"]).toBe(
      "node scripts/verify-phase-2d-subflows.mjs",
    );
    for (const source of [readme, spec]) {
      expect(source).toContain("npm run verify:phase2d:subflows");
      expect(source).toContain("credential-stripped");
      expect(source).toContain("SQLite-only");
      expect(source).toContain("no-spend");
    }
    expect(spec).toContain("D4-D7");
    expect(spec).toMatch(/pinned/i);
    expect(spec).toMatch(/breadcrumb/i);
    expect(readme).toContain("docs/architecture/typed-reusable-subflows.md");
    expect(guide).toContain("npm run verify:phase2d:subflows");
    expect(guide).toContain("12 trail entries");
    expect(guide).toContain("32 trail entries");
    expect(guide).toContain("current editable draft");
  });

  it("freezes focused subflow, full serial, SDK, cleanup, and Next gates in order", async () => {
    const { PHASE2D_SUBFLOW_STEPS } = await loadLibrary();
    const printable = printableSteps(PHASE2D_SUBFLOW_STEPS);

    expect(printable).toHaveLength(5);
    expect(printable[0]).toMatch(
      /^npm test -- --testTimeout=10000 --maxWorkers=1 --minWorkers=1 /,
    );
    for (const target of [
      "tests/flow/subflow-contract.test.ts",
      "tests/flow/subflow-dynamic-ports.test.ts",
      "tests/flow/subflow-node.test.ts",
      "tests/lib/run-service-subflow-recursion.test.ts",
      "tests/api-subflows-v2.test.ts",
      "tests/api-subflow-breadcrumbs-v2.test.ts",
      "tests/projects/subflow-version-pins.test.ts",
      "tests/flow/subflow-reference-ledger.test.ts",
      "tests/flow/subflow-reference-paste.test.ts",
      "tests/flow/subflow-reference-ui.test.tsx",
      "tests/flow/studio-reference-session-gate.test.ts",
      "tests/flow/studio-navigation.test.ts",
      "tests/flow/studio-history-guard.test.ts",
      "tests/flow/studio-recovery.test.ts",
      "tests/flow/run-subflow-preflight.test.ts",
      "tests/api-flow-lifecycle.test.ts",
      "tests/db/phase2d-supabase-migration.test.ts",
      "tests/manifest/v2-schema.test.ts",
      "tests/manifest/v2-roundtrip.test.ts",
      "tests/manifest/versioning.test.ts",
      "tests/flow/subflow-breadcrumb-session.test.ts",
      "tests/flow/subflow-studio-integration.test.ts",
      "tests/projects/subflow-breadcrumbs.test.tsx",
      "tests/projects/pinned-reference-banner.test.tsx",
      "tests/scripts/verify-phase2d.test.ts",
      "tests/scripts/verify-phase2d-subflows.test.ts",
      "tests/compat",
    ]) {
      expect(printable[0], target).toContain(target);
    }
    expect(printable[1]).toBe(
      "npm test -- --testTimeout=10000 --maxWorkers=1 --minWorkers=1",
    );
    expect(printable[2]).toBe("npm run build --workspace=@suedeai/agents");
    expect(printable[3]).toBe("remove:.next");
    expect(printable[4]).toBe("npm run build");

    const gate = printable.join("\n");
    expect(gate).not.toContain("verify:phase2d:subflows");
    expect(
      PHASE2D_SUBFLOW_STEPS.filter((step) => step.kind === "command").every(
        (step) => step.kind === "command" && step.command === "npm",
      ),
    ).toBe(true);
    expect(gate).not.toMatch(/\b(?:psql|vercel|curl|wget|deploy|db push|migration up)\b/i);
  });

  it("strips provider, Postgres, deployment, webhook, relay, wallet, and payment credentials", () => {
    const isolated = createIsolatedSqliteEnvironment({
      NODE_ENV: "test",
      ANTHROPIC_API_KEY: "anthropic",
      OPENAI_API_KEY: "openai",
      LLM_PROVIDER_URL: "https://llm.example",
      SUPABASE_URL: "https://db.example",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      DATABASE_URL: "postgres://production",
      VERCEL_URL: "production.example",
      X402_PRIVATE_KEY: "settlement",
      WALLET_PRIVATE_KEY: "wallet",
      X402_FACILITATOR_URL: "https://facilitator.example",
      SUEDE_RELAY_TOKEN: "relay",
      WEBHOOK_SECRET: "webhook",
      PROVIDER_ACCESS_TOKEN: "provider",
      DEV_OWNER_ID: "local-owner",
    });
    try {
      expect(isolated.environment).toMatchObject({
        DB_DRIVER: "sqlite",
        X402_SKIP_SETTLEMENT: "true",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        LLM_PROVIDER_URL: "",
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        DATABASE_URL: "",
        VERCEL_URL: "",
        X402_PRIVATE_KEY: "",
        WALLET_PRIVATE_KEY: "",
        X402_FACILITATOR_URL: "",
        SUEDE_RELAY_TOKEN: "",
        WEBHOOK_SECRET: "",
        PROVIDER_ACCESS_TOKEN: "",
        DEV_OWNER_ID: "local-owner",
      });
      expect(isolated.environment.SQLITE_PATH).toContain(isolated.directory);
    } finally {
      isolated.cleanup();
    }
  });

  it("inherits exact-tree, default-database, cleanup, and lock evidence", async () => {
    const { runPhase2dSubflowVerification } = await loadLibrary();
    const events: string[] = [];
    const output: string[] = [];

    runPhase2dSubflowVerification({
      steps: [{ kind: "command", command: "npm", args: ["test", "--", "focused"] }],
      requireEvidence: () => {
        events.push("git:before");
        return { commit: "commit", tree: "tree", dirty: false };
      },
      assertEvidence: () => events.push("git:after"),
      acquireLock: () => {
        events.push("lock:acquire");
        return { release: () => events.push("lock:release") };
      },
      snapshotDefaultDatabase: () => {
        events.push("db:before");
        return { files: [] };
      },
      assertDefaultDatabaseUnchanged: () => events.push("db:after"),
      createEnvironment: () => ({
        environment: { DB_DRIVER: "sqlite", SQLITE_PATH: "/tmp/isolated/studio.db" },
        cleanup: () => events.push("cleanup"),
      }),
      spawn: () => {
        events.push("command");
        return { status: 0 };
      },
      stdout: { write: (value: string) => output.push(value) },
      npmCommand: "npm",
    });

    expect(events).toEqual([
      "git:before",
      "lock:acquire",
      "db:before",
      "command",
      "db:after",
      "git:after",
      "cleanup",
      "lock:release",
    ]);
    expect(output.join("")).toContain("Phase 2D reusable subflows verification passed");
  });

  it("preserves command and invariant failures together", async () => {
    const { runPhase2dSubflowVerification } = await loadLibrary();
    let thrown: unknown;
    try {
      runPhase2dSubflowVerification({
        steps: [{ kind: "command", command: "npm", args: ["test"] }],
        requireEvidence: () => ({ commit: "commit", tree: "tree", dirty: false }),
        assertEvidence: () => {
          throw new Error("source changed");
        },
        acquireLock: () => ({ release: vi.fn() }),
        snapshotDefaultDatabase: () => ({ files: [] }),
        assertDefaultDatabaseUnchanged: () => {
          throw new Error("default database changed");
        },
        createEnvironment: () => ({ environment: { DB_DRIVER: "sqlite" }, cleanup: vi.fn() }),
        spawn: () => ({ status: 31 }),
        stdout: { write: vi.fn() },
        npmCommand: "npm",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const text = (thrown as AggregateError).errors.map(String).join("\n");
    expect(text).toContain("exited 31");
    expect(text).toContain("default database changed");
    expect(text).toContain("source changed");
  });
});
