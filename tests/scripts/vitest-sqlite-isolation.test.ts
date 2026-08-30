import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vitest SQLite isolation", () => {
  it("installs a disposable per-suite fallback instead of repository studio.db", () => {
    const config = readFileSync(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    const setup = readFileSync(
      resolve(process.cwd(), "tests/setup-isolated-sqlite.ts"),
      "utf8",
    );

    expect(config).toContain('setupFiles: ["./tests/setup-isolated-sqlite.ts"]');
    expect(setup).toContain("mkdtempSync");
    expect(setup).toContain("process.env.SQLITE_PATH = join(directory, \"studio.db\")");
    expect(setup).toContain("rmSync(directory, { recursive: true, force: true })");
    expect(setup).not.toContain('process.env.SQLITE_PATH = "studio.db"');
  });
});
