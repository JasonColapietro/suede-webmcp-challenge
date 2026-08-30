import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createIsolatedSqliteEnvironment } from "../../scripts/verification-env.mjs";

const libraryFile = resolve(process.cwd(), "scripts/verify-phase-2c-lib.mjs");
const wrapperFile = resolve(process.cwd(), "scripts/verify-phase-2c.mjs");

type VerificationStep =
  | { readonly kind: "command"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "remove"; readonly path: string };

async function loadLibrary() {
  const specifier = `../../scripts/verify-phase-2c-lib.mjs?test=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ specifier) as Promise<{
    PHASE2C_STEPS: readonly VerificationStep[];
    runPhase2cVerification(options?: Record<string, unknown>): void;
  }>;
}

function printableSteps(steps: readonly VerificationStep[]) {
  return steps.map((step) =>
    step.kind === "remove" ? `remove:${step.path}` : [step.command, ...step.args].join(" "),
  );
}

describe("Phase 2C release verifier", () => {
  it("ships an import-safe library and executable wrapper", () => {
    expect(existsSync(libraryFile)).toBe(true);
    expect(existsSync(wrapperFile)).toBe(true);
  });

  it("exposes and documents the exact local no-spend Phase 2C gate", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    const spec = readFileSync(
      resolve(
        process.cwd(),
        "docs/superpowers/specs/2026-07-10-phase-2-best-in-class-builder-design.md",
      ),
      "utf8",
    );

    expect(packageJson.scripts["verify:phase2c"]).toBe("node scripts/verify-phase-2c.mjs");
    expect(readme).toContain("npm run verify:phase2c");
    expect(readme).toContain("credential-stripped");
    expect(spec).toContain("Phase 2C delivered");
    expect(spec).toContain("v1 graphs remain v1");
    expect(spec).toMatch(/unknown\s+schemas remain connectable/);
    expect(spec).toContain("does not complete later parity phases");
  });

  it("freezes focused compatibility, full serial, SDK, cleanup, and Next gates in order", async () => {
    const { PHASE2C_STEPS } = await loadLibrary();
    const printable = printableSteps(PHASE2C_STEPS);

    expect(printable).toHaveLength(5);
    expect(printable[0]).toMatch(
      /^npm test -- --testTimeout=10000 --maxWorkers=1 --minWorkers=1 /,
    );
    for (const target of [
      "tests/flow/graph-v2-contract.test.ts",
      "tests/flow/graph-v2-codec.test.ts",
      "tests/flow/node-port-schemas.test.ts",
      "tests/flow/port-compatibility.test.ts",
      "tests/flow/typed-connection-integration.test.ts",
      "tests/flow/graph-command-v2.test.ts",
      "tests/flow/graph-command-v2-adversarial.test.ts",
      "tests/flow/graph-fragment-v2.test.ts",
      "tests/flow/value-bindings.test.ts",
      "tests/flow/engine-v2.test.ts",
      "tests/manifest/v2-schema.test.ts",
      "tests/manifest/v2-roundtrip.test.ts",
      "tests/projects/hash-v2.test.ts",
      "tests/flow/variable-ui-contract.test.ts",
      "tests/flow/binding-ui-contract.test.ts",
      "tests/flow/builder-accessibility.test.ts",
      "tests/compat",
      "tests/flow/engine.test.ts",
      "tests/manifest",
      "tests/projects/hash.test.ts",
      "tests/scripts/verification-env.test.ts",
      "tests/scripts/verify-phase1.test.ts",
      "tests/scripts/verify-phase2a.test.ts",
      "tests/scripts/verify-phase2b.test.ts",
      "tests/scripts/verify-phase2c.test.ts",
    ]) {
      expect(printable[0], target).toContain(target);
    }
    expect(printable[1]).toBe(
      "npm test -- --testTimeout=10000 --maxWorkers=1 --minWorkers=1",
    );
    expect(printable[2]).toBe("npm run build --workspace=@suedeai/agents");
    expect(printable[3]).toBe("remove:.next");
    expect(printable[4]).toBe("npm run build");
    expect(printable.join("\n")).not.toContain("verify:phase2c");
  });

  it("strips provider, database, webhook, relay, wallet, and payment credentials", () => {
    const isolated = createIsolatedSqliteEnvironment({
      ANTHROPIC_API_KEY: "anthropic",
      OPENAI_API_KEY: "openai",
      LLM_PROVIDER_URL: "https://llm.example",
      SUPABASE_URL: "https://db.example",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      DATABASE_URL: "postgres://production",
      VERCEL_URL: "production.example",
      X402_PRIVATE_KEY: "settlement",
      WALLET_PRIVATE_KEY: "wallet",
      X402_FACILITATOR_URL: "https://facilitator.example",
      SUEDE_RELAY_TOKEN: "relay",
      WEBHOOK_SECRET: "webhook",
      PROVIDER_ACCESS_TOKEN: "provider",
      SUEDE_WORKSPACE_KEY: "workspace-key",
      SUEDE_ID_SUPABASE_URL: "https://identity.example",
      SUEDE_ID_SUPABASE_ANON_KEY: "identity-anon",
      SUEDE_ID_SUPABASE_SERVICE_ROLE_KEY: "identity-service",
      PHASE0_CAPTURE_SESSION: "capture-token",
      DEV_OWNER_ID: "local-owner",
      NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3210",
      LLM_DEFAULT_MODEL: "local-stub-model",
      SUEDE_GATEWAY_STUB: "1",
      SUEDE_RELAY_SECRET: "relay-secret",
      SUEDE_API_URL: "https://agents.example",
      SUEDE_BASE_URL: "https://base.example",
      PROMO_AGENT_KEY: "promo-key",
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
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
        DATABASE_URL: "",
        VERCEL_URL: "",
        X402_PRIVATE_KEY: "",
        WALLET_PRIVATE_KEY: "",
        X402_FACILITATOR_URL: "",
        SUEDE_RELAY_TOKEN: "",
        WEBHOOK_SECRET: "",
        PROVIDER_ACCESS_TOKEN: "",
        SUEDE_WORKSPACE_KEY: "",
        SUEDE_ID_SUPABASE_URL: "",
        SUEDE_ID_SUPABASE_ANON_KEY: "",
        SUEDE_ID_SUPABASE_SERVICE_ROLE_KEY: "",
        PHASE0_CAPTURE_SESSION: "",
        DEV_OWNER_ID: "local-owner",
        NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3210",
        LLM_DEFAULT_MODEL: "local-stub-model",
        SUEDE_GATEWAY_STUB: "1",
        SUEDE_RELAY_SECRET: "",
        SUEDE_API_URL: "",
        SUEDE_BASE_URL: "",
        PROMO_AGENT_KEY: "",
      });
      expect(isolated.environment.SQLITE_PATH).toContain(isolated.directory);
    } finally {
      isolated.cleanup();
    }
  });

  it("uses hardened clean-tree, database, environment, cleanup, and lock evidence ordering", async () => {
    const { runPhase2cVerification } = await loadLibrary();
    const events: string[] = [];
    const output: string[] = [];
    const childEnvironments: Array<Record<string, string>> = [];

    runPhase2cVerification({
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
        return {
          files: ["studio.db", "studio.db-wal", "studio.db-shm"].map((name) => ({ name })),
        };
      },
      assertDefaultDatabaseUnchanged: () => events.push("db:after"),
      createEnvironment: () => ({
        environment: {
          DB_DRIVER: "sqlite",
          SQLITE_PATH: "/tmp/isolated/studio.db",
          X402_SKIP_SETTLEMENT: "true",
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
          SUPABASE_URL: "",
          SUPABASE_SERVICE_ROLE_KEY: "",
          WALLET_PRIVATE_KEY: "",
          X402_PRIVATE_KEY: "",
          X402_FACILITATOR_URL: "",
          DATABASE_URL: "",
          VERCEL_URL: "",
          WEBHOOK_SECRET: "",
        },
        cleanup: () => events.push("cleanup"),
      }),
      spawn: (_command: string, _args: readonly string[], options: { env: Record<string, string> }) => {
        events.push("command");
        childEnvironments.push(options.env);
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
    expect(childEnvironments).toHaveLength(1);
    expect(childEnvironments[0]).toMatchObject({
      DB_DRIVER: "sqlite",
      SQLITE_PATH: "/tmp/isolated/studio.db",
      X402_SKIP_SETTLEMENT: "true",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      WALLET_PRIVATE_KEY: "",
      X402_PRIVATE_KEY: "",
      X402_FACILITATOR_URL: "",
      DATABASE_URL: "",
      VERCEL_URL: "",
      WEBHOOK_SECRET: "",
    });
    const outputText = output.join("");
    expect(outputText).toContain("Phase 2C verification commit: commit");
    expect(outputText).toContain("Phase 2C verification tree: tree");
    expect(outputText).toContain("Phase 2C verification passed");
  });

  it("preserves command, database, git, cleanup, and lock failures together", async () => {
    const { runPhase2cVerification } = await loadLibrary();
    let thrown: unknown;
    try {
      runPhase2cVerification({
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
