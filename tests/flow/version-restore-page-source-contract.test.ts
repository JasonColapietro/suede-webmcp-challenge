import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "src/app/build/[flowId]/builder.tsx"), "utf8");

function section(start: string, end: string): string {
  const startIndex = page.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = page.indexOf(end, startIndex);
  expect(endIndex).toBeGreaterThan(startIndex);
  return page.slice(startIndex, endIndex);
}

describe("version restore page protocol", () => {
  it("captures row, fingerprint, and generation before checking blockers or fetching", () => {
    const body = section("const handleRestoreVersion", "const handleLaunch");
    for (const source of [
      "const restoreRowId = persistedIdRef.current",
      "const expectedDraftFingerprint = flowSaveFingerprint(restoreGraph)",
      "const requestGeneration = versionRestoreGenerationRef.current + 1",
    ]) expect(body).toContain(source);
    expect(body.indexOf("const restoreRowId")).toBeLessThan(body.indexOf("impactActionBlocker()"));
    expect(body.indexOf("impactActionBlocker()")).toBeLessThan(body.indexOf("fetchVersionForRestore({"));
    expect(body.indexOf('referenceBlocker("version")')).toBeLessThan(body.indexOf("fetchVersionForRestore({"));
  });

  it("fetches the exact owner-scoped row/version and refuses stale responses", () => {
    const body = section("const handleRestoreVersion", "const handleLaunch");
    expect(body).toContain("flowId: restoreRowId");
    expect(body).toContain("versionId");
    expect(body).toContain("signal: mutation.controller.signal");
    expect(body).toContain("persistedIdRef.current !== restoreRowId");
    expect(body).toContain("versionRestoreGenerationRef.current !== requestGeneration");
    expect(body).toContain("flowSaveFingerprint(currentGraph) !== expectedDraftFingerprint");
    expect(body.match(/impactActionBlocker\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(body.match(/referenceBlocker\("version"\)/g)?.length).toBeGreaterThanOrEqual(2);
    const blocker = section("const impactActionBlocker", "const testEnvironment");
    expect(page.match(/impactPendingRef\.current = impactPending/g)).toHaveLength(1);
    expect(page.match(/impactConfirmingRef\.current = impactConfirming/g)).toHaveLength(1);
    expect(page).toContain(
      "useLayoutEffect(() => {\n    impactPendingRef.current = impactPending;\n  }, [impactPending]);",
    );
    expect(page).toContain(
      "useLayoutEffect(() => {\n    impactConfirmingRef.current = impactConfirming;\n  }, [impactConfirming]);",
    );
    const renderPhase = section("const impactPendingRef", "const studioNavigationCoordinatorRef");
    expect(renderPhase.slice(0, renderPhase.indexOf("useLayoutEffect"))).not.toMatch(
      /impact(?:Pending|Confirming)Ref\.current\s*=/,
    );
    expect(blocker).toContain("impactPendingRef.current !== null");
    expect(blocker).toContain("impactConfirmingRef.current");
  });

  it("performs one synchronous graph.replace dispatch with no automatic persistence", () => {
    const body = section("const handleRestoreVersion", "const handleLaunch");
    expect(body).toContain("buildVersionRestoreCommand({");
    expect(body).toContain('kind: "draft-only"');
    expect(body).toContain("{ label: `Restore v${version.versionNumber}` }");
    expect(body).toContain("Restored v${version.versionNumber} to the draft. Save when ready. Undo is available.");
    expect(body).not.toMatch(/saveNow|resetLoadedGraph|supersedeWithoutSaving/);
    expect(body.match(/dispatch\(/g)).toHaveLength(1);
    const staleCheck = body.indexOf("flowSaveFingerprint(currentGraph) !== expectedDraftFingerprint");
    const dispatch = body.indexOf("dispatch(command");
    expect(staleCheck).toBeLessThan(dispatch);
    expect(body.slice(staleCheck, dispatch)).not.toContain("await ");
    const finalBoundary = body.slice(body.lastIndexOf("if (", dispatch), dispatch);
    expect(finalBoundary).toContain("ownsRequest(versionMutationSlotRef.current, mutation");
    expect(finalBoundary).toContain("versionReviewGenerationRef.current !== reviewGeneration");
    expect(finalBoundary).toContain("versionRestoreGenerationRef.current !== requestGeneration");
  });

  it("keeps restore on the existing Studio dispatch path without a special API", () => {
    expect(page).not.toMatch(/api\/v2\/flows\/[^`\n]*\/restore/);
    expect(page).not.toContain("restoreVersionSaveNow");
    const dispatchBody = section("const dispatch = useCallback", "const undo = useCallback");
    expect(dispatchBody).toContain('persistence.kind === "schedule"');
    expect(dispatchBody).toContain("scheduleSave(next.graph)");
  });

  it("invalidates and aborts restore on dismiss and keyed session abandonment", () => {
    const dismiss = section("const handleDismissVersionReview", "const handleReviewRestore");
    expect(dismiss).toContain("versionRestoreGenerationRef.current += 1");
    const cleanup = section("return () => abandonVersionReviewSession", "}, [flowId]);");
    expect(cleanup).toContain("restoreGeneration: versionRestoreGenerationRef");
    const wrapper = section("const handleReviewRestore", "const handlePromoteVersionToTest");
    expect(wrapper).toContain("handleRestoreVersion(selectedVersion.id, operation)");
  });
});
