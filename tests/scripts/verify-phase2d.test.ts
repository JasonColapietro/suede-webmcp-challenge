import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createIsolatedSqliteEnvironment } from "../../scripts/verification-env.mjs";

const libraryFile = resolve(process.cwd(), "scripts/verify-phase-2d-lib.mjs");
const wrapperFile = resolve(process.cwd(), "scripts/verify-phase-2d.mjs");

type VerificationStep =
  | { readonly kind: "command"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "remove"; readonly path: string };

async function loadLibrary() {
  const specifier = `../../scripts/verify-phase-2d-lib.mjs?test=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ specifier) as Promise<{
    PHASE2D_STEPS: readonly VerificationStep[];
    runPhase2dVerification(options?: Record<string, unknown>): void;
  }>;
}

function printableSteps(steps: readonly VerificationStep[]) {
  return steps.map((step) =>
    step.kind === "remove" ? `remove:${step.path}` : [step.command, ...step.args].join(" "),
  );
}

describe("Phase 2D release verifier", () => {
  it("ships an import-safe library and executable wrapper", () => {
    expect(existsSync(libraryFile)).toBe(true);
    expect(existsSync(wrapperFile)).toBe(true);
  });

  it("exposes and documents the exact local no-spend Phase 2D gate", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    const spec = readFileSync(
      resolve(
        process.cwd(),
        "docs/superpowers/specs/2026-07-10-phase-2-best-in-class-builder-design.md",
      ),
      "utf8",
    );

    expect(packageJson.scripts["verify:phase2d"]).toBe("node scripts/verify-phase-2d.mjs");
    expect(readme).toContain("npm run verify:phase2d");
    expect(readme).toContain("credential-stripped");
    expect(readme).toContain("SQLite-only");
    expect(readme).toContain("no-spend");
    expect(spec).toContain("Phase 2D delivered");
    expect(spec).toContain("D1-D3");
    expect(spec).toContain("D4+");
    expect(spec).toMatch(/subflow/i);
    expect(spec).toMatch(/deferred/i);
  });

  it("freezes focused compatibility, full serial, SDK, cleanup, and Next gates in order", async () => {
    const { PHASE2D_STEPS } = await loadLibrary();
    const printable = printableSteps(PHASE2D_STEPS);

    expect(printable).toHaveLength(5);
    expect(printable[0]).toMatch(
      /^npm test -- --testTimeout=10000 --maxWorkers=1 --minWorkers=1 /,
    );
    for (const target of [
      "tests/db/workbook-tabs-migration.test.ts",
      "tests/db/phase2d-supabase-migration.test.ts",
      "tests/projects/workbook-tabs-repo.test.ts",
      "tests/api-workbook-tabs-v2.test.ts",
      "tests/projects/workbook-tabs-ui.test.tsx",
      "tests/projects/workbook-tabs-navigation.test.ts",
      "tests/projects/workbook-tabs-ui-source-contract.test.ts",
      "tests/projects/route-row-id.test.ts",
      "tests/projects/ui-contract.test.ts",
      "tests/projects/ui-source-contract.test.ts",
      "tests/projects/sqlite-project-repo.test.ts",
      "tests/api-versions-v2.test.ts",
      "tests/flow/save-queue.test.ts",
      "tests/flow/builder-accessibility.test.ts",
      "tests/compat",
      "tests/scripts/verification-env.test.ts",
      "tests/scripts/verify-phase1.test.ts",
      "tests/scripts/verify-phase2a.test.ts",
      "tests/scripts/verify-phase2b.test.ts",
      "tests/scripts/verify-phase2c.test.ts",
      "tests/scripts/verify-phase2d.test.ts",
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
    expect(gate).not.toContain("verify:phase2d");
    expect(
      PHASE2D_STEPS.filter((step) => step.kind === "command").every(
        (step) =>
          step.kind === "command" &&
          !/^(?:psql|supabase|vercel|curl|wget|npx)$/i.test(step.command),
      ),
    ).toBe(true);
    expect(gate).not.toMatch(/\b(?:deploy|db push|migration up|sql execute)\b/i);
  });

  it("strips provider, Postgres, deployment, webhook, relay, wallet, and payment credentials", () => {
    const isolated = createIsolatedSqliteEnvironment({
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
    } as unknown as NodeJS.ProcessEnv);
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

  it("uses hardened clean-tree, database, environment, cleanup, and lock evidence ordering", async () => {
    const { runPhase2dVerification } = await loadLibrary();
    const events: string[] = [];
    const output: string[] = [];

    runPhase2dVerification({
      steps: [
        { kind: "command", command: "npm", args: ["test", "--", "focused"] },
        { kind: "remove", path: ".next" },
      ],
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
        environment: {
          DB_DRIVER: "sqlite",
          SQLITE_PATH: "/tmp/isolated/studio.db",
          X402_SKIP_SETTLEMENT: "true",
          DATABASE_URL: "",
          SUPABASE_URL: "",
          VERCEL_URL: "",
          OPENAI_API_KEY: "",
        },
        cleanup: () => events.push("cleanup"),
      }),
      spawn: () => {
        events.push("command");
        return { status: 0 };
      },
      removeNext: () => events.push("remove:.next"),
      stdout: { write: (value: string) => output.push(value) },
      npmCommand: "npm",
    });

    expect(events).toEqual([
      "git:before",
      "lock:acquire",
      "db:before",
      "command",
      "remove:.next",
      "db:after",
      "git:after",
      "cleanup",
      "lock:release",
    ]);
    expect(output.join("")).toContain("Phase 2D verification commit: commit");
    expect(output.join("")).toContain("Phase 2D verification tree: tree");
    expect(output.join("")).toContain("Phase 2D verification passed");
  });

  it("preserves command, database, git, cleanup, and lock failures together", async () => {
    const { runPhase2dVerification } = await loadLibrary();
    let thrown: unknown;
    try {
      runPhase2dVerification({
        steps: [{ kind: "command", command: "npm", args: ["test"] }],
        requireEvidence: () => ({ commit: "commit", tree: "tree", dirty: false }),
        assertEvidence: () => {
          throw new Error("source changed");
        },
        acquireLock: () => ({
          release: () => {
            throw new Error("lock cleanup failed");
          },
        }),
        snapshotDefaultDatabase: () => ({ files: [] }),
        assertDefaultDatabaseUnchanged: () => {
          throw new Error("default database changed");
        },
        createEnvironment: () => ({
          environment: { DB_DRIVER: "sqlite" },
          cleanup: () => {
            throw new Error("environment cleanup failed");
          },
        }),
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
    expect(text).toContain("environment cleanup failed");
    expect(text).toContain("lock cleanup failed");
  });
});
