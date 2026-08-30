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

describe("builder impact confirmation protocol", () => {
  it("sends an optional receipt only through update and strictly parses one response body", () => {
    const update = section("update: async", "},\n      },");
    expect(page).toContain("ImpactRequiredError");
    expect(update).toContain("impactReceipt?: string");
    expect(update).toContain("impactReceipt === undefined");
    expect(update).toContain("{ impactReceipt }");
    expect(update.match(/await res\.json\(\)/g)).toHaveLength(1);
    expect(update).toContain("ImpactRequiredError.parse(res.status, data)");
    expect(update.indexOf("ImpactRequiredError.parse")).toBeLessThan(update.indexOf("throw new Error(`Save failed"));
  });

  it("publishes coordinator impact state and suppresses the generic retry error", () => {
    expect(page).toContain("const [impactPending, setImpactPending]");
    expect(page).toContain("const [impactDialogOpen, setImpactDialogOpen]");
    expect(page).toContain("const [impactConfirming, setImpactConfirming]");
    expect(page).toContain("onImpactPendingChange: (pending)");
    expect(page).toContain("setImpactPending(pending)");
    expect(page).toContain("setImpactDialogOpen(pending !== null)");
    expect(page).toContain("error instanceof ImpactRequiredError");
    expect(page).toContain("setSaveError(null)");
    expect(page).toContain("impactPending && !impactDialogOpen");
  });

  it("supersedes impact before bootstrap or reference gates can return", () => {
    expect(page).toContain("saveCoordinatorRef.current!.supersedeWithoutSaving(next)");
    for (const body of [
      section("const persist = useCallback", "const scheduleSave"),
      section("const scheduleSave", "useEffect(() =>"),
    ]) {
      expect(body.match(/supersedeWithoutSaving\(next\)/g)).toHaveLength(2);
      const activeBranch = body.slice(body.indexOf("if (activeBootstrapToken"), body.indexOf('const blocker = referenceBlocker("save")'));
      expect(activeBranch.indexOf("supersedeWithoutSaving(next)")).toBeLessThan(
        activeBranch.indexOf("return"),
      );
      const blockerBranch = body.slice(body.indexOf("if (blocker)"));
      expect(blockerBranch.indexOf("supersedeWithoutSaving(next)")).toBeLessThan(
        blockerBranch.indexOf("return"),
      );
    }
    const retry = section("const handleRetrySave", "const handleConfirmImpact");
    expect(retry).toContain("updateReferenceBootstrapGraph(token, currentGraph)");
    expect(retry).toContain("saveNow(createReferenceBootstrapGraph(currentGraph))");
    expect(retry).toContain("else {");
    expect(retry).toContain("retryLatest()");
  });

  it("guards every persistence-dependent action before its side effect", () => {
    const cases = [
      ["const handleRetrySave", "const writeSelectionToClipboard", "retryLatest()"],
      ["const handleSaveVersion", "const handleLaunch", "saveNow(versionGraph)"],
      ["const handleLaunch", "const handleWorkbookTabActivate", "saveNow(graph)"],
      ["const handleWorkbookTabActivate", "const restoreCreatedFlowRoute", "studioNavigationCoordinatorRef.current.run({"],
    ] as const;
    for (const [start, end, effect] of cases) {
      const body = section(start, end);
      expect(body).toContain("impactActionBlocker");
      expect(body.indexOf("impactActionBlocker")).toBeLessThan(body.indexOf(effect));
      expect(body).toMatch(/if \(impactBlocked\)[\s\S]*?return/);
    }
    const version = section("const handleSaveVersion", "const handleLaunch");
    expect(version).toContain("const versionGraph = structuredClone(graph)");
    expect(version).toContain("const versionFingerprint = flowSaveFingerprint(versionGraph)");
    expect(version.indexOf("saveNow(versionGraph)")).toBeLessThan(version.indexOf("saveVersionCheckpoint({"));
    expect(version.indexOf("saveNow(versionGraph)")).toBeLessThan(
      version.indexOf("flowSaveFingerprint(currentGraph) !== versionFingerprint"),
    );
    expect(version.indexOf("flowSaveFingerprint(currentGraph) !== versionFingerprint")).toBeLessThan(
      version.indexOf("saveVersionCheckpoint({"),
    );
    expect(version).toContain("graph: versionGraph");
  });

  it("renders owner-safe dialog and persistent dismissed banner outside desktop-only UI", () => {
    expect(page).toContain('import FlowImpactDialog from "@/components/canvas/FlowImpactDialog"');
    expect(page).toContain("<FlowImpactDialog");
    expect(page).toContain("impact={impactPending?.impact ?? null}");
    expect(page).toContain("onConfirm={() => void handleConfirmImpact()}");
    expect(page).toContain("onDismiss={() => setImpactDialogOpen(false)}");
    expect(page).toContain("onClick={() => setImpactDialogOpen(true)}");
    const dialogIndex = page.indexOf("<FlowImpactDialog");
    const editorIndex = page.indexOf('className="studio-desktop-only studio-editor-body"');
    expect(dialogIndex).toBeGreaterThanOrEqual(0);
    expect(dialogIndex).toBeLessThan(editorIndex);
    const renderStart = page.indexOf("  return (", page.indexOf("const impactBlockedMessage"));
    const jsx = page.slice(renderStart, page.indexOf("\nfunction Banner", renderStart));
    expect(jsx).not.toMatch(/receipt/i);
    expect(page).not.toMatch(/set(?:CommandAnnouncement|VersionAnnouncement|LaunchError)\([^)]*receipt/i);
    expect(page).not.toMatch(/console\.[a-z]+\([^)]*receipt/i);
  });

  it("combines impact and reference blockers at the RunDock boundary", () => {
    expect(page).toContain("prepareRun={persistedId ? undefined : async () => {");
    expect(page).toContain("runBlocker={() => impactActionBlocker() ?? referenceBlocker(\"run\")?.message ?? null}");
  });
});
