import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ephemeral scoped test runner source contract", () => {
  it("has no persistence, provider, rail, network, ambient-env, or production-run boundary", () => {
    const source = readFileSync("src/lib/flow/test-runner.ts", "utf8");
    expect(source).toContain("runCompiledTestFlow");
    expect(source).toContain("validateAndCompileTestRunRequest");
    expect(source).toContain("preflightPlannedTestNodes");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:run-service|run-context|\/db|\/projects|\/rails|providers?|gateway|\/api)[^"']*["']/u);
    expect(source).not.toMatch(/\b(?:fetch|process\.env|getRepo|buildRunContext|runAndStream|collectRun|RunLogger|createRun|appendStep|finishRun)\b/u);

    const runtime = readFileSync("src/lib/flow/test-runtime.ts", "utf8");
    expect(runtime).toContain("NODE_DEFS");
    expect(runtime).toContain("scopedTestStubFor");
    expect(runtime).toContain("createSafeScopedTestRuntime");
    expect(runtime).not.toMatch(/from\s+["'][^"']*(?:engine|run-service|run-context|\/db|\/projects|\/rails|providers?|gateway|\/api)[^"']*["']/u);
    expect(runtime).not.toMatch(/\b(?:fetch|process\.env|getRepo|buildRunContext|runAndStream|collectRun|RunLogger|createRun|appendStep|finishRun)\b/u);
  });
});
