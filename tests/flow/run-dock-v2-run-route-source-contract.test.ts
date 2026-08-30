import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("RunDock v2 run boundary", () => {
  it("sends builder runs through the preflighted v2 route", () => {
    const source = readFileSync(join(process.cwd(), "src/components/canvas/RunDock.tsx"), "utf8");
    expect(source).toContain("fetch(`/api/v2/flows/${encodeURIComponent(executionFlowId)}/run`");
    expect(source).toContain("flowVersionId: immutableVersion.id");
    expect(source).not.toContain("fetch(`/api/flows/${flowId}/run`");
  });

  it("persists a new template before either scoped or ordinary execution", () => {
    const source = readFileSync(join(process.cwd(), "src/components/canvas/RunDock.tsx"), "utf8");
    const run = source.slice(source.indexOf("const runLegacyV2"), source.indexOf("const durableVersionKey"));
    expect(run).toContain("const preparedFlowId = await prepareRun()");
    expect(run).toContain("executionFlowId = preparedFlowId");
    expect(run.indexOf("await prepareRun()")).toBeLessThan(run.indexOf("if (scopedMode)"));
    expect(run).toContain("await runScopedTest(executionFlowId)");
  });
});
