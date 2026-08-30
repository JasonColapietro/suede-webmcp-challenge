import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  join(process.cwd(), "src/app/build/[flowId]/builder.tsx"),
  "utf8",
);

function section(start: string, end: string): string {
  const startIndex = page.indexOf(start);
  return page.slice(startIndex, page.indexOf(end, startIndex));
}

describe("builder scoped-test wiring", () => {
  it("owns a nullable test scope and resolves the exact project Test environment", () => {
    expect(page).toContain('import type { FlowTestScope } from "@/lib/flow/test-scope"');
    expect(page).toContain("const [testScope, setTestScope] = useState<FlowTestScope | null>(null)");
    expect(page).toMatch(/\.environments\.find\(\s*\(environment\) => environment\.kind === "test",?\s*\)/);
    expect(page).not.toMatch(/testEnvironment\s*=\s*\{[^}]*id:\s*["']/s);
  });

  it("shares every admission blocker and clears a scope whenever admission becomes invalid", () => {
    const admission = section("const testRunDisabledReason", "const handleRunTestScope");
    expect(admission).toContain("impactActionBlocker()");
    expect(admission).toContain('referenceBlocker("run")');
    expect(admission).toContain("contextLoading");
    expect(admission).toContain("persistedId");
    expect(admission).toContain("schemaVersion");
    expect(admission).toContain("projectContext");
    expect(admission).toContain("testEnvironment");
    expect(page).toContain("testScopeNodeExists");
    expect(page).toContain("v2TestGraph.nodes.some((node) => node.id === testScope.nodeId)");
    expect(page).toContain("testRunDisabledReason !== null || !testScopeNodeExists");
    const cleanup = section(
      "if (testScope !== null && (testRunDisabledReason !== null || !testScopeNodeExists))",
      "const pasteNavigationBlocker",
    );
    expect(cleanup).not.toContain("runDockBusy");
  });

  it("checks busy, impact, and reference gates before accepting an Inspector scope", () => {
    const handler = section("const handleRunTestScope", "useEffect(() =>");
    expect(handler).toContain("if (runDockBusy) return");
    expect(handler).toContain("impactActionBlocker()");
    expect(handler).toContain('referenceBlocker("run")');
    expect(handler).toContain("setTestScope(scope)");
    expect(handler.indexOf("impactActionBlocker()")).toBeLessThan(handler.indexOf('referenceBlocker("run")'));
    expect(handler.indexOf('referenceBlocker("run")')).toBeLessThan(handler.indexOf("setTestScope(scope)"));
  });

  it("connects Inspector and RunDock without importing a test route", () => {
    expect(page).toContain("const [runDockBusy, setRunDockBusy] = useState<boolean>(false)");
    expect(page).toContain("onRunTestScope={handleRunTestScope}");
    expect(page).toContain("testRunDisabledReason={testRunDisabledReason}");
    expect(page).toContain("testRunBusy={runDockBusy}");
    expect(page).not.toContain("testRunBusy={false}");
    expect(page).toContain("graph={v2TestGraph}");
    expect(page).toContain("testEnvironment={testEnvironment ? { id: testEnvironment.id, name: testEnvironment.name } : null}");
    expect(page).toContain("testScope={effectiveTestScope}");
    // The header's next-safe-action ladder wraps the busy setter so it can
    // record whether the starting run is scoped; the dock's running state
    // still lands in runDockBusy.
    expect(page).toContain("onRunningChange={handleRunDockRunning}");
    expect(page).toContain("setRunDockBusy(running)");
    expect(page).toContain("onTestScopeClear={() => setTestScope(null)}");
    expect(page).not.toMatch(/from\s+["'][^"']*api\/v2\/[^"']*test[^"']*["']/);
  });
});
