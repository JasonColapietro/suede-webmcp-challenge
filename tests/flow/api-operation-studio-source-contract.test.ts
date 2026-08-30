import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("API operation Studio integration source contract", () => {
  it("owns one closure-backed resolver and separate action lifecycles", () => {
    const source = readFileSync("src/app/build/[flowId]/builder.tsx", "utf8");
    const authoring = readFileSync("src/lib/connectors/studio-authoring.ts", "utf8");

    expect(source).toContain("createStudioOperationPortResolver");
    expect(source).toContain("resolveOperations");
    expect(source).toContain("assertGraphPortReferences(graph, undefined, resolveAuthoringPorts ?? undefined)");
    expect(source).toMatch(/<FlowCanvas[\s\S]*resolvePorts=\{resolveAuthoringPorts/);
    expect(source).toMatch(/<Inspector[\s\S]*resolvePorts=\{resolveAuthoringPorts/);
    expect(source).toContain("onBrowseApiOperations");
    expect(authoring).toContain("bindings: {}");
    expect(source).toContain("simulationAbortRef");
    expect(source).toContain("readinessAbortRef");
    expect(source).not.toContain('handleAddNode("api.operation")');
  });

  it("returns picker focus to the exact API node trigger after close or selection", () => {
    const build = readFileSync("src/app/build/[flowId]/builder.tsx", "utf8");
    const palette = readFileSync("src/components/canvas/NodePalette.tsx", "utf8");
    const browser = readFileSync("src/components/connectors/ConnectorBrowser.tsx", "utf8");

    expect(build).toContain("apiOperationPickerTriggerRef");
    expect(build).toContain("apiOperationTriggerRef={apiOperationPickerTriggerRef}");
    expect(build).toContain("returnFocusRef={apiOperationPickerTriggerRef}");
    expect(palette).toContain("apiOperationTriggerRef?: React.RefObject<HTMLButtonElement | null>");
    expect(palette).toContain("ref={apiOperation ? apiOperationTriggerRef : undefined}");
    expect(browser).toMatch(/onPick\(outcome\.closure\);[\s\S]{0,180}queueMicrotask\(\(\) => returnFocusRef\?\.current\?\.focus\(\)\)/u);
  });
});
