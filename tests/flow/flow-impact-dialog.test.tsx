import { readFileSync } from "node:fs";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import FlowImpactDialog, {
  boundedImpactView,
  claimImpactConfirmation,
} from "@/components/canvas/FlowImpactDialog";
import type { FlowImpactSummary } from "@/lib/flow/flow-mutation-service";

const impact: FlowImpactSummary = {
  dependents: [
    { flowId: "row-secret-one", name: "Morning brief", nodeIds: ["node-secret-a", "node-secret-b"] },
    { flowId: "row-secret-two", name: "Client follow-up", nodeIds: ["node-secret-c"] },
  ],
  truncated: true,
  total: 9,
};

describe("FlowImpactDialog", () => {
  it("renders nothing unless both open and a bounded impact summary are present", () => {
    const props = {
      busy: false,
      onConfirm: vi.fn(),
      onDismiss: vi.fn(),
    };
    expect(renderToStaticMarkup(createElement(FlowImpactDialog, { ...props, open: false, impact }))).toBe("");
    expect(renderToStaticMarkup(createElement(FlowImpactDialog, { ...props, open: true, impact: null }))).toBe("");
  });

  it("renders one labelled modal alert with bounded names and counts but no private identities", () => {
    const markup = renderToStaticMarkup(createElement(FlowImpactDialog, {
      open: true,
      busy: false,
      impact,
      onConfirm: vi.fn(),
      onDismiss: vi.fn(),
      triggerRef: createRef<HTMLElement>(),
    }));
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby=');
    expect(markup).toContain('aria-describedby=');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain("Review affected flows");
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("2 uses");
    expect(markup).toContain("Client follow-up");
    expect(markup).toContain("1 use");
    expect(markup).toContain("9 total affected flows");
    expect(markup).toContain("The server limited this list");
    expect(markup).toContain(">Keep editing<");
    expect(markup).toContain(">Confirm exact save<");
    for (const privateValue of ["row-secret-one", "row-secret-two", "node-secret-a", "node-secret-c", "receipt"]) {
      expect(markup.toLowerCase()).not.toContain(privateValue);
    }
  });

  it("disables both actions and announces progress while the exact save is busy", () => {
    const markup = renderToStaticMarkup(createElement(FlowImpactDialog, {
      open: true,
      busy: true,
      impact,
      onConfirm: vi.fn(),
      onDismiss: vi.fn(),
    }));
    expect(markup).toContain('aria-busy="true"');
    expect(markup.match(/ disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Saving confirmed changes…");
  });

  it("bounds hostile direct summaries before rendering", () => {
    const direct: FlowImpactSummary = {
      dependents: Array.from({ length: 60 }, (_, index) => ({
        flowId: `private-${index}`,
        name: `${String(index).padStart(2, "0")}-${"n".repeat(250)}`,
        nodeIds: Array.from({ length: 80 }, (_, nodeIndex) => `private-node-${nodeIndex}`),
      })),
      truncated: false,
      total: 50_000,
    };
    const view = boundedImpactView(direct);
    expect(view.dependents).toHaveLength(50);
    expect(view.dependents.every((dependent) => dependent.name.length <= 200)).toBe(true);
    expect(view.dependents.every((dependent) => dependent.useCount <= 50)).toBe(true);
    expect(view.total).toBe(1_000);
    expect(view.truncated).toBe(true);
    expect(JSON.stringify(view)).not.toContain("private-node");
    expect(JSON.stringify(view)).not.toContain("private-0");
  });

  it("claims confirmation synchronously once, including against reentrant activation", () => {
    const latch = { current: false };
    let calls = 0;
    if (claimImpactConfirmation(latch)) {
      calls += 1;
      if (claimImpactConfirmation(latch)) calls += 1;
    }
    if (claimImpactConfirmation(latch)) calls += 1;
    expect(calls).toBe(1);
    latch.current = false;
    expect(claimImpactConfirmation(latch)).toBe(true);
  });

  it("implements safe initial focus, containment, dismissal, and connected trigger restoration", () => {
    const source = readFileSync("src/components/canvas/FlowImpactDialog.tsx", "utf8");
    expect(source).toContain("keepEditingRef.current?.focus()");
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain("document.activeElement");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("!locked");
    expect(source).toContain("event.target === event.currentTarget");
    expect(source).toContain("onDismiss()");
    expect(source).toContain("trigger?.isConnected");
    expect(source).toContain("trigger.focus()");
    expect(source).toContain("document.activeElement");
    expect(source).toContain("activeElement instanceof HTMLElement");
    expect(source).toContain("[triggerRef, visible]");
    expect(source).not.toMatch(/\[[^\]]*impact[^\]]*\]/);
    expect(source).toContain("const busyBegan = visible && busy && !previousBusyRef.current");
    expect(source).toContain("if (busyBegan) queueMicrotask(() => dialogRef.current?.focus())");
    const busyEffect = source.slice(source.indexOf("const busyBegan"), source.indexOf("}, [busy, visible]);") + 18);
    expect(busyEffect).not.toContain("return () =>");
    const confirmStart = source.indexOf('className="flow-impact-dialog__confirm"');
    const confirmHandler = source.slice(confirmStart, source.indexOf(">Confirm exact save", confirmStart));
    expect(confirmHandler).toContain("claimImpactConfirmation(confirmationClaimedRef)");
    expect(confirmHandler.indexOf("claimImpactConfirmation")).toBeLessThan(confirmHandler.indexOf("onConfirm();"));
    expect(source).toContain("if (event.target === event.currentTarget && !locked) onDismiss();");
    expect(source).not.toContain("if (event.target === event.currentTarget && !locked) onConfirm();");
  });

  it("uses the fixed opaque Suede overlay above editor layers and remains visible at 759px", () => {
    const styles = readFileSync("src/app/site.css", "utf8");
    const start = styles.indexOf(".flow-impact-dialog__backdrop");
    expect(start).toBeGreaterThan(-1);
    const scoped = styles.slice(start, styles.indexOf("/* ----", start + 10) > start
      ? styles.indexOf("/* ----", start + 10)
      : styles.length);
    expect(scoped).toMatch(/\.flow-impact-dialog__backdrop\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*(?:10[1-9]|1[1-9][0-9]|[2-9][0-9]{2,})/s);
    expect(scoped).toContain("background: var(--ink-deep)");
    expect(scoped).toContain("background: var(--ink-panel)");
    expect(scoped).toContain("border: 1px solid var(--warning-amber)");
    expect(scoped).toMatch(/\.flow-impact-dialog__actions button\s*\{[^}]*min-height:\s*44px/s);
    expect(scoped).toMatch(/@media \(max-width: 759px\)[\s\S]*\.flow-impact-dialog\s*\{[^}]*width:\s*100%/s);
    expect(scoped).not.toMatch(/rgba|transparent|opacity|gradient|color-mix/);
  });
});
