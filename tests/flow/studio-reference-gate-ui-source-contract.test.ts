import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");
const section = (value: string, start: string, end: string): string => {
  const startIndex = value.indexOf(start);
  return value.slice(startIndex, value.indexOf(end, startIndex));
};

describe("Studio reference gate wiring", () => {
  const page = source("src/app/build/[flowId]/builder.tsx");
  const runDock = source("src/components/canvas/RunDock.tsx");

  it("owns one route-bound session gate and reconciles every graph-history transition", () => {
    expect(page).toContain('from "@/lib/flow/studio-reference-session-gate"');
    expect(page).toContain("const referenceGateRef = useRef(new StudioReferenceSessionGate())");
    expect(page).toContain("const sessionParentFlowId = isNew ? null : flowId");
    expect(page).toContain("parentFlowId={sessionParentFlowId}");
    expect(page).not.toContain("parentFlowId={persistedId}");
    expect(page).toContain("referenceGateRef.current.reset(sessionParentFlowId, nextGraph)");
    expect(page).toContain('referenceGateRef.current.reconcile(sessionParentFlowId, next.graph, "edit")');
    expect(page).toContain('referenceGateRef.current.reconcile(sessionParentFlowId, next.graph, "undo")');
    expect(page).toContain('referenceGateRef.current.reconcile(sessionParentFlowId, next.graph, "redo")');
  });

  it("marks only the exact resolved node receipt and then schedules that now-verified graph", () => {
    const handler = page.slice(
      page.indexOf("const handleSubflowReferenceResolved"),
      page.indexOf("const handleVariablePatch"),
    );
    expect(handler).toContain("referenceGateRef.current.markResolved(");
    expect(handler).toContain("sessionParentFlowId");
    expect(handler).toContain("projection.reference");
    expect(handler.indexOf("dispatch({")).toBeLessThan(handler.indexOf("markResolved("));
    expect(handler.indexOf("markResolved(")).toBeLessThan(handler.indexOf("scheduleSave("));
  });

  it("guards save, retry, version, launch, workbook navigation, and run before side effects", () => {
    for (const action of ["save", "retry-save", "version", "launch", "workbook-navigation", "global-navigation", "run"]) {
      expect(page).toContain(`referenceBlocker("${action}")`);
    }
    const persist = section(page, "const persist", "const scheduleSave");
    const schedule = section(page, "const scheduleSave", "useEffect(() =>");
    const retry = section(page, "const handleRetrySave", "const writeSelectionToClipboard");
    const version = section(page, "const handleSaveVersion", "const handleLaunch");
    const launch = section(page, "const handleLaunch", "const handleWorkbookTabActivate");
    const workbook = section(page, "const handleWorkbookTabActivate", "const selectedNode");
    for (const [body, gate, effect] of [
      [persist, 'referenceBlocker("save")', "saveCoordinatorRef.current!.saveNow(next)"],
      [schedule, 'referenceBlocker("save")', "saveCoordinatorRef.current!.schedule(next)"],
      [version, 'referenceBlocker("version")', "setVersionSaving(true)"],
      [launch, 'referenceBlocker("launch")', "saveCoordinatorRef.current!.saveNow(graph)"],
      [workbook, 'referenceBlocker("workbook-navigation")', "workbookSwitchRef.current = target.flowId"],
    ] as const) {
      expect(body.indexOf(gate)).toBeGreaterThanOrEqual(0);
      expect(body.indexOf(gate)).toBeLessThan(body.indexOf(effect));
      expect(body).toMatch(/if \(blocker\)[\s\S]*?return/);
    }
    expect(retry.indexOf('referenceBlocker("retry-save")')).toBeLessThan(
      retry.indexOf("saveCoordinatorRef.current!.retryLatest()"),
    );
    expect(retry).toContain("if (blocker && !retryingReferenceBootstrap)");
    expect(page).toContain("prepareRun={persistedId ? undefined : async () => {");
    expect(page).toContain("runBlocker={() => impactActionBlocker() ?? referenceBlocker(\"run\")?.message ?? null}");
  });

  it("makes RunDock refuse a blocked run before parsing input or issuing fetch", () => {
    expect(runDock).toContain("runBlocker?: () => string | null");
    expect(runDock).toContain("const blocked = runBlocker?.() ?? null");
    expect(runDock).toContain("setError(blocked)");
    expect(runDock.indexOf("const blocked = runBlocker")).toBeLessThan(runDock.indexOf("JSON.parse(triggerInputText)"));
    expect(runDock.indexOf("const blocked = runBlocker")).toBeLessThan(runDock.indexOf("await fetch("));
  });

  it("bootstraps only a safe parent and carries the deferred graph into the authoritative route", () => {
    expect(page).toContain("stageReferenceBootstrapGraph(next)");
    expect(page).toContain("saveNow(createReferenceBootstrapGraph(next))");
    const createTransport = section(page, "create: async", "update: async");
    expect(createTransport).toContain("bindReferenceBootstrapGraph(bootstrapToken, rowId)");
    expect(createTransport.indexOf("bindReferenceBootstrapGraph")).toBeLessThan(
      createTransport.indexOf("return rowId"),
    );
    const onCreated = section(page, "onCreated:", "onSavingChange:");
    expect(onCreated).not.toContain("bindReferenceBootstrapGraph");
    expect(page).not.toContain("referenceBootstrapTokenRef.current = null");
    const arbitration = section(page, "const holdDeferredWork", "const installWarning");
    expect(arbitration).toContain("const rowId = pendingAuthoritativeLoad.rowId");
    expect(arbitration).toContain("peekReferenceBootstrapGraph(rowId)");
    expect(arbitration).toContain("const chosen = heldDeferredGraphRef.current ?? authoritative");
    expect(arbitration).toContain("resetLoadedGraph(chosen)");
    expect(arbitration).toContain("consumeReferenceBootstrapGraph(rowId)");
    expect(arbitration).toContain('referenceGateRef.current.blocker("save") === null');
    expect(arbitration.indexOf("peekReferenceBootstrapGraph(rowId)")).toBeLessThan(
      arbitration.indexOf("resetLoadedGraph(chosen)"),
    );
    expect(arbitration.indexOf("resetLoadedGraph(chosen)")).toBeLessThan(
      arbitration.indexOf("consumeReferenceBootstrapGraph(rowId)"),
    );
    expect(arbitration.indexOf("consumeReferenceBootstrapGraph(rowId)")).toBeLessThan(
      arbitration.indexOf("saveCoordinatorRef.current!.schedule(heldDeferredGraphRef.current)"),
    );
    expect(arbitration.indexOf('referenceGateRef.current.blocker("save") === null')).toBeLessThan(
      arbitration.indexOf("saveCoordinatorRef.current!.schedule(heldDeferredGraphRef.current)"),
    );
    expect(page).not.toContain("discardReferenceBootstrapGraph(token)");
  });

  it("exposes durable save, launch, and run blocker feedback to assistive technology", () => {
    expect(page).toContain('id="studio-reference-save-status"');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('"verification needed · not saved"');
    expect(page).toContain("const launchActionBlocker = impactBlockedMessage ?? referenceBlocker(\"launch\")?.message ?? null");
    expect(page).toContain("aria-disabled={Boolean(launchActionBlocker)}");
    expect(page).toContain('aria-describedby={launchActionBlocker ? "studio-reference-save-status" : undefined}');
    expect(runDock).toContain("aria-disabled={running || Boolean(blockedMessage)}");
    expect(runDock).toContain("aria-describedby={visibleError ? blockerStatusId : undefined}");
    expect(runDock).toContain('role="status"');
  });
});
