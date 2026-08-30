import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createIsolatedSqliteEnvironment } from "../../scripts/verification-env.mjs";

const libraryFile = resolve(process.cwd(), "scripts/verify-phase-2f-lib.mjs");
const wrapperFile = resolve(process.cwd(), "scripts/verify-phase-2f.mjs");

type VerificationStep =
  | { readonly kind: "command"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "remove"; readonly path: string };

async function loadLibrary() {
  const specifier = `../../scripts/verify-phase-2f-lib.mjs?test=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ specifier) as Promise<{
    PHASE2F_STEPS: readonly VerificationStep[];
    runPhase2fVerification(options?: Record<string, unknown>): void;
  }>;
}

function printableSteps(steps: readonly VerificationStep[]) {
  return steps.map((step) =>
    step.kind === "remove" ? `remove:${step.path}` : [step.command, ...step.args].join(" "),
  );
}

describe("Phase 2F version restore and promotion release verifier", () => {
  it("ships an import-safe library, executable wrapper, and honest release documentation", () => {
    expect(existsSync(libraryFile)).toBe(true);
    expect(existsSync(wrapperFile)).toBe(true);
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts["verify:phase2f"]).toBe("node scripts/verify-phase-2f.mjs");
    const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    const spec = readFileSync(
      resolve(
        process.cwd(),
        "docs/superpowers/specs/2026-07-10-phase-2-best-in-class-builder-design.md",
      ),
      "utf8",
    );
    const guide = readFileSync(
      resolve(process.cwd(), "docs/architecture/version-restore-promotion.md"),
      "utf8",
    );
    for (const source of [readme, spec, guide]) {
      expect(source).toContain("npm run verify:phase2f");
      expect(source).toContain("SQLite-only");
      expect(source).toContain("no-spend");
      expect(source).toMatch(/current-head visual/i);
    }
    expect(readme).toContain("docs/architecture/version-restore-promotion.md");
    expect(spec).toContain("Phase 2F delivered");
    expect(guide).toContain("structural diff");
    expect(guide).toContain("immutable version");
    expect(guide).toContain("mutable Draft");
    expect(guide).toContain("does not auto-save");
    expect(guide).toContain("undo");
    expect(guide).toContain("PROMOTE TEST");
    expect(guide).toContain("PROMOTE LIVE");
    expect(guide).toContain("Test receipt is not proof that the version passed tests");
    expect(guide).toContain("Manual UAT checklist");
    expect(guide).toContain("browser evidence is unavailable");
    expect(guide).toContain("organizational deployment rollback");
  });

  it("freezes Slice F, prior verifier laws, full serial tests, SDK, cleanup, and Next build", async () => {
    const { PHASE2F_STEPS } = await loadLibrary();
    const printable = printableSteps(PHASE2F_STEPS);
    expect(printable).toHaveLength(5);
    expect(printable[0]).toMatch(
      /^npm test -- --testTimeout=10000 --maxWorkers=1 --minWorkers=1 /,
    );
    for (const target of [
      "tests/projects/version-diff.test.ts",
      "tests/projects/version-service.test.ts",
      "tests/api-version-compare-v2.test.ts",
      "tests/projects/hash.test.ts",
      "tests/projects/hash-v2.test.ts",
      "tests/projects/version-restore.test.ts",
      "tests/flow/version-restore-page-source-contract.test.ts",
      "tests/flow/graph-history.test.ts",
      "tests/flow/graph-command-reducer.test.ts",
      "tests/projects/deployment-service.test.ts",
      "tests/api-deployments-v2.test.ts",
      "tests/db/deployment-migration.test.ts",
      "tests/projects/sqlite-project-repo.test.ts",
      "tests/projects/version-review-dialog.test.tsx",
      "tests/projects/ui-contract.test.ts",
      "tests/projects/ui-source-contract.test.ts",
      "tests/flow/impact-confirmation-page-source-contract.test.ts",
      "tests/compat",
      "tests/scripts/verification-env.test.ts",
      "tests/scripts/verify-phase1.test.ts",
      "tests/scripts/verify-phase2a.test.ts",
      "tests/scripts/verify-phase2b.test.ts",
      "tests/scripts/verify-phase2c.test.ts",
      "tests/scripts/verify-phase2d.test.ts",
      "tests/scripts/verify-phase2d-subflows.test.ts",
      "tests/scripts/verify-phase2e.test.ts",
      "tests/scripts/verify-phase2f.test.ts",
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
    expect(gate).not.toContain("verify:phase2f");
    expect(
      PHASE2F_STEPS.filter((step) => step.kind === "command").every(
        (step) => step.kind === "command" && step.command === "npm",
      ),
    ).toBe(true);
    expect(gate).not.toMatch(
      /\b(?:psql|supabase|vercel|curl|wget|deploy|db push|migration up|payment|settlement)\b/i,
    );
  });

  it("strips provider, database, deployment, webhook, relay, wallet, and payment credentials", () => {
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

  it("inherits exact-tree, default-database, cleanup, and lock evidence in order", async () => {
    const { runPhase2fVerification } = await loadLibrary();
    const events: string[] = [];
    const output: string[] = [];
    runPhase2fVerification({
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
        environment: { DB_DRIVER: "sqlite", SQLITE_PATH: "/tmp/isolated/studio.db" },
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
    expect(output.join("")).toContain(
      "Phase 2F version restore and promotion verification passed",
    );
  });

  it("preserves command, database, git, cleanup, and lock failures together", async () => {
    const { runPhase2fVerification } = await loadLibrary();
    let thrown: unknown;
    try {
      runPhase2fVerification({
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
