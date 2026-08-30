import { readFileSync } from "node:fs";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import VersionReviewDialog, {
  activateVersionReviewAction,
  claimVersionReviewAction,
  dismissVersionReviewOnCancel,
  dismissVersionReviewOnEscape,
  focusVersionReview,
  restoreVersionReviewFocus,
} from "@/components/projects/VersionReviewDialog";
import type { FlowVersionRecord, FlowVersionSemanticDiff } from "@/lib/projects/types";

const version: FlowVersionRecord = {
  id: "version-selected",
  flowId: "flow-private",
  versionNumber: 4,
  schemaVersion: 2,
  label: "Release candidate",
  description: "Creator rights routing",
  graph: { schemaVersion: 2, id: "graph", name: "Graph", nodes: [], edges: [], variables: [], groups: [], annotations: [] },
  semanticHash: "a".repeat(64),
  fullHash: "b".repeat(64),
  createdBy: "owner-private",
  createdAt: 1,
  dependencies: [],
};

const diff: FlowVersionSemanticDiff = {
  from: { id: "version-selected", versionNumber: 4, semanticHash: "a".repeat(64) },
  to: { id: "version-latest", versionNumber: 7, semanticHash: "c".repeat(64) },
  semanticEqual: false,
  fullEqual: false,
  visualOnly: false,
  changedSections: ["dependencies", "edges", "nodes", "variables"],
  counts: { added: 2, removed: 1, changed: 1 },
  entries: [
    { kind: "node", id: "node-a", change: "changed", fields: ["params.prompt"] },
    { kind: "edge", id: "edge-a", change: "removed", fields: [] },
    { kind: "variable", id: "var-a", change: "added", fields: [] },
    { kind: "dependency", id: "[\"agent\",\"rights\"]", change: "added", fields: [] },
  ],
  truncated: false,
};

function markup(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(VersionReviewDialog, {
    open: true,
    readOnly: false,
    busyAction: null,
    version,
    diffState: { status: "ready", diff },
    activeTestVersionId: "version-selected",
    livePhrase: "",
    onLivePhraseChange: vi.fn(),
    onDismiss: vi.fn(),
    onRestore: vi.fn(),
    onPromoteTest: vi.fn(),
    onPromoteLive: vi.fn(),
    restoreDisabledReason: null,
    testDisabledReason: null,
    liveDisabledReason: null,
    triggerRef: createRef<HTMLElement>(),
    ...overrides,
  }));
}

describe("VersionReviewDialog", () => {
  it("renders a native labelled modal with exact immutable hashes and all structural buckets", () => {
    const html = markup();
    expect(html).toContain("<dialog");
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Review v4");
    expect(html).toContain("Release candidate");
    expect(html).toContain("Creator rights routing");
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("b".repeat(64));
    for (const label of ["Nodes", "Edges", "Variables", "Dependencies"]) expect(html).toContain(label);
    expect(html).toContain("params.prompt");
    expect(html).toContain("Restore to draft");
    expect(html).toContain("Confirm Promote to Test");
    expect(html).toContain("PROMOTE LIVE");
    expect(html).toContain("not proof that a scoped test passed");
  });

  it("uses fixed loading, error, empty, and layout-only receipts", () => {
    expect(markup({ version: null, diffState: { status: "loading" } })).toContain("Loading exact version receipt…");
    expect(markup({ diffState: { status: "error" } })).toContain("Version review is unavailable. Close and try again.");
    expect(markup({ diffState: { status: "ready", diff: { ...diff, semanticEqual: true, fullEqual: true, changedSections: [], counts: { added: 0, removed: 0, changed: 0 }, entries: [] } } })).toContain("No structural changes");
    expect(markup({ diffState: { status: "ready", diff: { ...diff, semanticEqual: true, fullEqual: false, visualOnly: true, changedSections: [], counts: { added: 0, removed: 0, changed: 0 }, entries: [] } } })).toContain("Layout-only change");
    expect(markup({ diffState: { status: "error", message: "SECRET raw server trace" } })).not.toContain("SECRET");
  });

  it("offers Live only for the active Test version and only enables the exact typed phrase", () => {
    expect(markup({ activeTestVersionId: "another-version" })).not.toContain('name="live-confirmation"');
    expect(markup({ livePhrase: "promote live" })).toContain('name="live-confirmation"');
    expect(markup({ livePhrase: "PROMOTE LIVE" })).toContain(">Promote to Live<");
  });

  it("removes mutation controls in read-only mode and synchronously prevents duplicate actions", () => {
    const html = markup({ readOnly: true });
    expect(html).not.toContain("Restore to draft");
    expect(html).not.toContain("Confirm Promote to Test");
    const latch = { current: false };
    expect(claimVersionReviewAction(latch)).toBe(true);
    expect(claimVersionReviewAction(latch)).toBe(false);
  });

  it("shows fixed disabled reasons without exposing server text", () => {
    const html = markup({
      restoreDisabledReason: "Review the reusable-flow impact before restoring.",
      testDisabledReason: "Environment receipts are unavailable.",
      liveDisabledReason: "The active Test receipt is a different version.",
    });
    expect(html).toContain("Review the reusable-flow impact before restoring.");
    expect(html).toContain("Environment receipts are unavailable.");
    expect(html).toContain("The active Test receipt is a different version.");
  });

  it("implements cancel, Escape, focus containment, and connected trigger focus return", () => {
    const source = readFileSync("src/components/projects/VersionReviewDialog.tsx", "utf8");
    expect(source).toContain("dialog.showModal()");
    expect(source).toContain("onCancel=");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain("cancelRef.current?.focus()");
    expect(source).toContain("trigger?.isConnected");
    expect(source).toContain("trigger.focus()");
  });

  it("behaviorally focuses, dismisses, restores focus, and blocks duplicate action clicks", () => {
    const cancel = { focus: vi.fn() };
    const dialog = { focus: vi.fn() };
    focusVersionReview({ current: cancel }, { current: dialog }, () => cancel);
    expect(cancel.focus).toHaveBeenCalledOnce();
    expect(dialog.focus).not.toHaveBeenCalled();
    focusVersionReview({ current: cancel }, { current: dialog }, () => null);
    expect(dialog.focus).toHaveBeenCalledOnce();

    const dismiss = vi.fn();
    const escape = { key: "Escape", preventDefault: vi.fn() };
    expect(dismissVersionReviewOnEscape(escape, false, dismiss)).toBe(true);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(dismissVersionReviewOnEscape({ key: "Escape", preventDefault: vi.fn() }, true, dismiss)).toBe(false);
    const cancelEvent = { preventDefault: vi.fn() };
    expect(dismissVersionReviewOnCancel(cancelEvent, false, dismiss)).toBe(true);
    expect(cancelEvent.preventDefault).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledTimes(2);

    const trigger = { isConnected: true, focus: vi.fn() };
    restoreVersionReviewFocus(trigger);
    expect(trigger.focus).toHaveBeenCalledOnce();
    const disconnected = { isConnected: false, focus: vi.fn() };
    restoreVersionReviewFocus(disconnected);
    expect(disconnected.focus).not.toHaveBeenCalled();

    const latch = { current: false };
    const action = vi.fn();
    expect(activateVersionReviewAction(latch, false, action)).toBe(true);
    expect(activateVersionReviewAction(latch, false, action)).toBe(false);
    expect(action).toHaveBeenCalledOnce();
  });
});
