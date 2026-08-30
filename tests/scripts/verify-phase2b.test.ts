import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const libraryFile = resolve(process.cwd(), "scripts/verify-phase-2b-lib.mjs");
const wrapperFile = resolve(process.cwd(), "scripts/verify-phase-2b.mjs");

async function loadLibrary() {
  const specifier = `../../scripts/verify-phase-2b-lib.mjs?test=${Date.now()}-${Math.random()}`;
  return import(/* @vite-ignore */ specifier) as Promise<{
    PHASE2B_STEPS: ReadonlyArray<
      | { readonly kind: "command"; readonly command: string; readonly args: readonly string[] }
      | { readonly kind: "remove"; readonly path: string }
    >;
    runPhase2bVerification(options?: Record<string, unknown>): void;
  }>;
}

describe("Phase 2B release verifier", () => {
  it("ships an import-safe library and executable wrapper", () => {
    expect(existsSync(libraryFile)).toBe(true);
    expect(existsSync(wrapperFile)).toBe(true);
  });

  it("exposes the verifier and documents local no-spend graph editing", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");

    expect(packageJson.scripts["verify:phase2b"]).toBe("node scripts/verify-phase-2b.mjs");
    expect(readme).toContain("npm run verify:phase2b");
    expect(readme).toContain("Local no-spend builder");
  });

  it("freezes the focused, full, SDK, cleanup, and Next gates in release order", async () => {
    const { PHASE2B_STEPS } = await loadLibrary();
    const printable = PHASE2B_STEPS.map((step) =>
      step.kind === "remove" ? `remove:${step.path}` : [step.command, ...step.args].join(" "),
    );

    expect(printable).toHaveLength(5);
    expect(printable[0]).toMatch(
      /^npm test -- --testTimeout=10000 --maxWorkers=1 --minWorkers=1 /,
    );
    expect(printable[0]).toContain("tests/flow/graph-command-contract.test.ts");
    expect(printable[0]).toContain("tests/flow/node-definitions.test.ts");
    expect(printable[0]).toContain("tests/compat/manifest-v1.test.ts");
    expect(printable[0]).toContain("tests/projects/hash.test.ts");
    expect(printable[0]).toContain("tests/flow/save-queue.test.ts");
    expect(printable[0]).toContain("tests/flow/builder-accessibility.test.ts");
    expect(printable[0]).toContain("tests/scripts/verify-phase2a.test.ts");
    expect(printable[0]).toContain("tests/scripts/verify-phase2b.test.ts");
    expect(printable[1]).toBe(
      "npm test -- --testTimeout=10000 --maxWorkers=1 --minWorkers=1",
    );
    expect(printable[2]).toBe("npm run build --workspace=@suedeai/agents");
    expect(printable[3]).toBe("remove:.next");
    expect(printable[4]).toBe("npm run build");
    expect(printable.join("\n")).not.toContain("verify:phase2b");
  });

  it("runs through the hardened shared evidence runner with a Phase 2B label", async () => {
    const { runPhase2bVerification } = await loadLibrary();
    const events: string[] = [];
    const output: string[] = [];

    runPhase2bVerification({
      steps: [
        { kind: "command", command: "npm", args: ["test", "--", "focused"] },
        { kind: "remove", path: ".next" },
      ],
      requireEvidence: () => ({ commit: "commit", tree: "tree", dirty: false }),
      assertEvidence: () => events.push("git:after"),
      acquireLock: () => ({ release: () => events.push("lock:release") }),
      snapshotDefaultDatabase: () => ({ files: [] }),
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
      stdout: { write: (value: string) => output.push(value) },
      npmCommand: "npm",
    });

    expect(events).toEqual([
      "npm test -- focused",
      "remove:.next",
      "db:after",
      "git:after",
      "cleanup",
      "lock:release",
    ]);
    expect(output.join("")).toContain("Phase 2B verification commit: commit");
    expect(output.join("")).toContain("Phase 2B verification passed");
  });

  it("preserves command, evidence, cleanup, and lock failures together", async () => {
    const { runPhase2bVerification } = await loadLibrary();
    let thrown: unknown;
    try {
      runPhase2bVerification({
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
        assertDefaultDatabaseUnchanged: vi.fn(),
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
    expect(text).toContain("source changed");
    expect(text).toContain("environment cleanup failed");
    expect(text).toContain("lock cleanup failed");
  });
});
