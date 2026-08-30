import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("subflow Studio integration", () => {
  it("renders one shared responsive breadcrumb DOM and wires guarded child and ancestor navigation", () => {
    const source = readFileSync("src/app/build/[flowId]/builder.tsx", "utf8");
    expect(source.match(/<SubflowBreadcrumbs\b/g)).toHaveLength(1);
    expect(source.match(/<PinnedReferenceBanner\b/g)).toHaveLength(1);
    expect(source).toContain('fetch("/api/v2/subflows/breadcrumbs"');
    expect(source).toContain("validateSubflowBreadcrumbResponse");
    expect(source).toContain("stageSubflowBreadcrumbRouteEffect");
    expect(source).toContain("deriveSubflowAncestorReturn");
    expect(source).toContain("onOpenResolvedSubflow");
    expect(source).toContain("focusNodeRequest");
    expect(source).toContain("subflowTrailValidatedRef.current = true");
    expect(source).toContain("if (!subflowTrailValidatedRef.current)");
    expect(source).toContain("const focusGraph = historyRef.current?.graph");
    expect(source).not.toContain("interfaceHash: localPin.interfaceHash");
  });

  it("keeps physical history unwind ahead of atomic session staging and rearms on staging failure", () => {
    const source = readFileSync("src/app/build/[flowId]/builder.tsx", "utf8");
    const handler = source.slice(source.indexOf("const navigateSubflowTrail"), source.indexOf("const navigateSubflowTrail") + 8_000);
    expect(handler).toContain("studioNavigationCoordinatorRef.current.run");
    expect(handler).toContain("beginRouteEffectRef.current(() =>");
    expect(handler.indexOf("beginRouteEffectRef.current(() =>")).toBeLessThan(handler.indexOf("stageSubflowBreadcrumbRouteEffect"));
    expect(handler).toContain("studioHistoryGuardRef.current?.mount()");
    expect(handler).toContain("flowSaveFingerprint(latestReferenceGraph)");
  });
});
