import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("flow test scope planner source contract", () => {
  it("stays synchronous, pure, client-safe, and dispatch-free", () => {
    const source = readFileSync("src/lib/flow/test-scope.ts", "utf8");
    expect(source).toContain("export function planFlowTestScope(");
    expect(source).not.toMatch(/export async function planFlowTestScope|Promise</);
    expect(source).not.toMatch(/from ["'][^"']*(?:engine|executor|registry|run-service)["']/);
    expect(source).not.toMatch(/@\/lib\/(?:db|projects|rails|gateway)/);
    expect(source).not.toMatch(/\b(?:fetch|executeNode|runFlow|resolveSecretReference|resolveValueBinding)\b/);
  });
});
