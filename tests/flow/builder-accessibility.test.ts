import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import BuilderCommandBar from "@/components/canvas/BuilderCommandBar";
import CommandPalette from "@/components/canvas/CommandPalette";
import type { BuilderCommandContext } from "@/lib/flow/builder-command-registry";

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");
const context: BuilderCommandContext = {
  canUndo: false, canRedo: false, canPaste: false,
  selectedNodeIds: [], selectedEdgeIds: [], boundedNodeIds: [], graphNodeCount: 0,
};

describe("accessible builder commands", () => {
  it("renders compact visible controls as focusable aria-disabled buttons with reasons", () => {
    const markup = renderToStaticMarkup(createElement(BuilderCommandBar, { context, onCommand: vi.fn() }));
    for (const label of ["Undo", "Redo", "Delete", "Duplicate", "Auto-layout", "Commands"]) {
      expect(markup).toContain(`>${label}<`);
    }
    expect(markup).toContain('aria-label="Builder commands"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('aria-label="Undo. Nothing to undo."');
    expect(markup).toContain('title="Nothing to undo."');
    expect(markup).not.toContain(" disabled");
  });

  it("renders a labelled modal search/listbox with visible disabled reasons", () => {
    const markup = renderToStaticMarkup(createElement(CommandPalette, {
      open: true, context, onClose: vi.fn(), onCommand: vi.fn(), triggerRef: { current: null },
    }));
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="builder-command-palette-title"');
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('aria-activedescendant=');
    expect(markup).toContain("Select at least one node or edge.");
  });

  it("implements keyboard navigation, focus containment, and trigger restoration", () => {
    const palette = source("src/components/canvas/CommandPalette.tsx");
    expect(palette).toContain('event.key === "ArrowDown"');
    expect(palette).toContain('event.key === "ArrowUp"');
    expect(palette).toContain('event.key === "Enter"');
    expect(palette).toContain('event.key === "Escape"');
    expect(palette).toContain('event.key === "Tab"');
    expect(palette).toContain("triggerRef.current?.focus()");
  });

  it("scopes shortcuts away from form fields and prioritizes native clipboard events", () => {
    const shortcuts = source("src/components/canvas/useBuilderShortcuts.ts");
    expect(shortcuts).toContain("isEditableTarget");
    expect(shortcuts).toMatch(/INPUT|TEXTAREA|SELECT/);
    expect(shortcuts).toContain("isContentEditable");
    expect(shortcuts).toContain('addEventListener("copy"');
    expect(shortcuts).toContain('addEventListener("paste"');
    expect(shortcuts).toContain("commandForShortcut(event)");
    expect(source("src/lib/flow/builder-command-registry.ts")).toContain('key === "z"');
  });

  it("uses locked tokens and one solid primary focus treatment without forbidden styling", () => {
    const styles = source("src/app/site.css");
    const commands = styles.slice(styles.indexOf(".builder-command-bar"));
    expect(commands).toContain("var(--ink-panel)");
    expect(commands).toContain("var(--canvas-bg)");
    expect(commands).toContain("var(--primary)");
    expect(commands).toContain("var(--hairline-visible)");
    expect(commands).toContain("outline: 3px solid var(--primary)");
    expect(commands).not.toContain("gradient");
  });

  it("keeps one polite live region and never sources announcements from graph params", () => {
    const page = source("src/app/build/[flowId]/builder.tsx");
    expect(page.match(/aria-live="polite"/g)).toHaveLength(1);
    const announcements = page.match(/setCommandAnnouncement\([^)]*\)/g)?.join("\n") ?? "";
    expect(announcements).not.toMatch(/params|clipboardText|JSON\.stringify/);
    expect(page).toContain("pendingPasteControllerRef.current!.commit(");
    expect(page).toContain("commitPendingPasteBatch(");
    expect(page.indexOf("commitPendingPasteBatch(")).toBeLessThan(
      page.indexOf("scheduleSave(committedGraph)"),
    );
    expect(page).toContain('className="builder-command-announcement"');
  });

  it("clears the transient command toast so it cannot pin the live region", () => {
    const page = source("src/app/build/[flowId]/builder.tsx");
    // commandAnnouncement leads the live-region fallback chain, so a value that
    // is never reset both parks a stale toast over the canvas and blocks every
    // later launch/save announcement. Verified in-browser: set at 331ms,
    // cleared at 6815ms, re-set at 7411ms, cleared again at 13796ms.
    expect(page).toMatch(/const COMMAND_ANNOUNCEMENT_MS = \d+;/);
    expect(page).toMatch(
      /if \(commandAnnouncement === ""\) return;[\s\S]{0,200}setCommandAnnouncement\(""\), COMMAND_ANNOUNCEMENT_MS\)/,
    );
    // The clear must be the first entry of the live-region chain, otherwise a
    // stale command message outranks a fresh launch failure.
    expect(page).toMatch(/\{commandAnnouncement \|\| launchError \|\|/);
  });

  it("keeps typed data controls keyboard-visible and usable at a narrow desktop width", () => {
    const styles = source("src/app/site.css");
    const variables = source("src/components/canvas/FlowVariablesPanel.tsx");
    const node = source("src/components/canvas/SuedeNode.tsx");
    expect(styles).toContain(".flow-variables-panel");
    expect(styles).toContain(".data-receipt");
    expect(styles).toMatch(/\.flow-variable-form textarea\s*\{[^}]*min-height:\s*var\(--control-h\)/s);
    expect(styles).toMatch(/\.flow-variable-form__actions button\s*\{[^}]*min-height:\s*var\(--control-h\)/s);
    expect(styles).toMatch(/\.flow-variable-form__check\s*\{[^}]*min-height:\s*var\(--control-h\)/s);
    expect(styles).toMatch(/\.flow-variables-panel[^}]*button:focus-visible/s);
    expect(styles).toMatch(/@media \(max-width: 1279px\)/);
    expect(styles).toContain("minmax(280px, 34vw)");
    expect(styles).toMatch(/@media \(max-width: 1279px\)[\s\S]*\.builder-command-bar\s*\{[^}]*right:\s*8px[^}]*left:\s*8px[^}]*flex-wrap:\s*wrap[^}]*transform:\s*none/s);
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toMatch(/@media \(max-width: 1279px\)[\s\S]*\.studio-header\s*\{[^}]*flex-wrap:\s*wrap[^}]*overflow[^:]*:\s*(?:visible|hidden)/s);
    expect(styles).not.toMatch(/@media \(max-width: 1279px\)[\s\S]*\.studio-header\s*\{[^}]*overflow-x:\s*auto/s);
    expect(styles).toMatch(/@media \(max-width: 1279px\)[\s\S]*\.builder-command-announcement\s*\{[^}]*top:\s*96px/s);
    expect(variables).toContain("aria-describedby");
    expect(variables).toContain('type="button"');
    expect(node).toContain("tabIndex: 0");
    expect(node).toContain("activateHandleFromKeyboard");
  });

  it("keeps the one workbook tablist keyboard-visible above the mobile guard", () => {
    const page = source("src/app/build/[flowId]/builder.tsx");
    const styles = source("src/app/site.css");
    expect(page.match(/<WorkbookTabs/g)).toHaveLength(1);
    expect(page.indexOf("<WorkbookTabs")).toBeLessThan(page.indexOf("studio-mobile-guard"));
    expect(styles).toMatch(/\.workbook-tabs__tab\s*\{[^}]*min-height:\s*44px/s);
    expect(styles).toMatch(/\.workbook-tabs__tab:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--primary\)/s);
    expect(styles).toMatch(
      /@media \(forced-colors: active\)\s*\{[\s\S]*?\.workbook-tabs__tab\[aria-selected="true"\]\s*\{[^}]*outline:\s*2px solid Highlight/s,
    );
    expect(styles).toMatch(/@media \(max-width: 1279px\)[\s\S]*\.studio-mobile-guard\s*\{[^}]*position:\s*static/s);
  });
});
