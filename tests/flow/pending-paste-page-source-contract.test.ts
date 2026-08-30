import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "src/app/build/[flowId]/builder.tsx"), "utf8");
const session = readFileSync(join(process.cwd(), "src/lib/flow/studio-paste-session.ts"), "utf8");

function section(start: string, end: string): string {
  const startIndex = page.indexOf(start);
  return page.slice(startIndex, page.indexOf(end, startIndex));
}

describe("builder pending typed paste protocol", () => {
  it("uses one opaque controller and one reference client without raw paste or duplicate commands", () => {
    expect(page).toContain("PendingSubflowPasteController");
    expect(page).toContain("createSubflowReferenceClient");
    expect(page).toContain("const pendingPasteControllerRef = useRef");
    expect(page).toContain("const subflowPasteClientRef = useRef");
    expect(session).toContain("class PendingPasteIntent");
    expect(session).toContain("const PENDING_PASTE_CONTENTS = new WeakMap");
    expect(page).not.toContain("commandForPaste(");
    expect(page).not.toContain("commandForSelectionDuplicate(");
    expect(page).toContain("serializeGraphFragment(current, selectionRef.current)");
  });

  it("resolves every future node with an abort signal before one synchronous batch commit", () => {
    const pipeline = section("const startPendingPaste", "const pasteFragmentText");
    expect(pipeline).toContain("pendingPasteControllerRef.current!.begin({");
    expect(pipeline).toContain("plan.requests()");
    expect(pipeline).toContain("subflowPasteClientRef.current!.resolve({");
    expect(pipeline).toContain("signal: operationEpoch.signal");
    expect(pipeline.indexOf("await subflowPasteClientRef.current!.resolve")).toBeLessThan(
      pipeline.lastIndexOf("commitResolved(resolutions)"),
    );
    expect(pipeline).toContain("requestedFingerprint: request.fingerprint");
    expect(section("const commitPendingPasteBatch", "const startPendingPaste")).toContain("kind !== \"graph.batch\"");
    expect(pipeline).toContain("commitPendingPasteBatch(");
  });

  it("marks every materialized receipt before exactly one allowed save", () => {
    const pipeline = section("const startPendingPaste", "const pasteFragmentText");
    const commit = section("const commitPendingPasteBatch", "const startPendingPaste");
    expect(commit).toContain("referenceGateRef.current.markResolved(");
    expect(commit.indexOf("referenceGateRef.current.markResolved(")).toBeLessThan(
      commit.indexOf("setHistory(next)"),
    );
    expect(pipeline.match(/scheduleSave\(committedGraph\)/g)).toHaveLength(1);
    expect(commit).toContain("referenceGateRef.current.reconcile(sessionParentFlowId, next.graph, transition)");
    expect(commit).not.toContain("scheduleSave(");
  });

  it("cancels on graph lifecycle changes and superseding paste without mutating history early", () => {
    expect(page).toContain("const cancelPendingPaste");
    expect(page).toContain("pendingPasteEpochGuardRef.current!.cancelForGraphMutation()");
    expect(page).toContain("pendingPasteControllerRef.current!.cancel()");
    expect(section("const dispatch", "const undo")).toContain("cancelPendingPaste(");
    expect(section("const undo", "const redo")).toContain("cancelPendingPaste(");
    expect(section("const redo", "const handleAddNode")).toContain("cancelPendingPaste(");
    const pipeline = section("const startPendingPaste", "const pasteFragmentText");
    expect(pipeline.indexOf("cancelPendingPaste()")).toBeLessThan(pipeline.indexOf(".begin({"));
    expect(pipeline).toContain("pendingPasteEpochGuardRef.current!.isCurrent(operationEpoch)");
    expect(pipeline.indexOf("setHistory(")).toBe(-1);
    expect(pipeline.indexOf("scheduleSave(")).toBeGreaterThan(pipeline.indexOf(".commit("));
  });

  it("defers typed first-action intent across a bounded exact-row safe bootstrap", () => {
    expect(page).toContain("stageDeferredPasteIntent(");
    expect(page).toContain("bindDeferredPasteIntent(deferredPasteToken, rowId)");
    expect(page).toContain("consumeDeferredPasteIntent(rowId)");
    expect(page).toContain("bootstrapReferenceParent(currentGraph)");
    expect(page).toContain("setRouteDeferredPasteIntent(resumed)");
    expect(page).toContain("tryStartPendingPaste(routeDeferredPasteIntent)");
    expect(page).not.toMatch(/sessionStorage[^\n]*paste|localStorage[^\n]*paste/);
  });

  it("supersedes deferred intent, retries only a safe parent, and fails closed with owner-safe copy", () => {
    const pipeline = section("const startPendingPaste", "const pasteFragmentText");
    expect(pipeline.indexOf("discardDeferredPasteIntent(priorDeferredToken)")).toBeLessThan(
      pipeline.indexOf("const typed = fragmentHasTypedReferences"),
    );
    expect(pipeline.indexOf('referenceBlocker("save")')).toBeLessThan(pipeline.indexOf(".begin({"));
    expect(pipeline).toContain("saveNow(createReferenceBootstrapGraph(currentGraph))");
    expect(pipeline).toContain("referenceBootstrapTokenRef.current !== null && !saving");
    expect(pipeline).not.toContain("error.message");
    const cancellation = section("const cancelPendingPaste", "const replaceSelection");
    expect(cancellation).toContain("const hadPendingOperation");
    expect(cancellation).toContain("message && hadPendingOperation");
    expect(section("const dispatch", "const undo")).toContain("cancelPendingPaste(\"Paste cancelled because the flow changed. Retry paste.\", true)");
    expect(page).toContain("const tryStartPendingPaste");
    const duplicate = section('if (id === "selection.duplicate")', 'if (id === "selection.delete")');
    expect(duplicate).toContain("tryStartPendingPaste(createPendingPasteIntent({");
  });

  it("keeps trusted typed copy memory-only while external clipboard text is detached", () => {
    const copy = section("const writeSelectionToClipboard", "const startPendingPaste");
    expect(copy).toContain("createTrustedClipboardIntent(fragment, text)");
    expect(copy).toContain("detachTypedReferencesForExternalClipboard(fragment)");
    expect(copy).toContain("JSON.stringify(externalFragment)");
    expect(page).toContain("readTrustedClipboardIntent(trustedClipboardRef.current, text)");
    expect(page).not.toContain("readTrustedClipboardIntent(trustedClipboardRef.current);");
    expect(page).toContain("pasteResolutionError");
    expect(page).toContain("Retry paste");
  });
});
