import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import WorkbookTabs, {
  consumeWorkbookTabFocus,
  type WorkbookTabFocusHandoff,
} from "@/components/projects/WorkbookTabs";
import type { WorkbookFlowTab } from "@/lib/projects/types";

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

const tabs: WorkbookFlowTab[] = [
  { id: "tab-b", workbookId: "book", flowId: "row-b", title: "Research", position: 1, createdAt: 2, updatedAt: 2 },
  { id: "tab-a", workbookId: "book", flowId: "row-a", title: "Main", position: 0, createdAt: 1, updatedAt: 1 },
];

describe("WorkbookTabs", () => {
  it("renders one ordered labelled tablist with controlled active and busy state", () => {
    const markup = renderToStaticMarkup(createElement(WorkbookTabs, {
      tabs,
      activeFlowId: "row-a",
      busyFlowId: "row-b",
      error: null,
      focusHandoff: { current: null },
      onActivate: vi.fn(),
    }));

    expect(markup.match(/role="tablist"/g)).toHaveLength(1);
    expect(markup.match(/role="tab"/g)).toHaveLength(2);
    expect(markup.indexOf("Main")).toBeLessThan(markup.indexOf("Research"));
    expect(markup).toContain('aria-label="Workbook flows"');
    expect(markup).toMatch(/aria-selected="true"[^>]*aria-current="page"[^>]*tabindex="0"/);
    expect(markup).toMatch(/aria-selected="false"[^>]*aria-busy="true"[^>]*tabindex="-1"/);
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
  });

  it("consumes cross-session focus only for the matching target and only once", () => {
    const handoff: WorkbookTabFocusHandoff = { current: "row-b" };
    const focus = vi.fn();
    expect(consumeWorkbookTabFocus(handoff, "row-a", focus)).toBe(false);
    expect(handoff.current).toBe("row-b");
    expect(consumeWorkbookTabFocus(handoff, "row-b", focus)).toBe(true);
    expect(handoff.current).toBeNull();
    expect(consumeWorkbookTabFocus(handoff, "row-b", focus)).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("implements manual roving activation and blocks modified clicks", () => {
    const component = source("src/components/projects/WorkbookTabs.tsx");
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "]) {
      expect(component).toContain(`event.key === "${key}"`);
    }
    expect(component).toContain("event.metaKey");
    expect(component).toContain("event.ctrlKey");
    expect(component).toContain("event.altKey");
    expect(component).toContain("event.shiftKey");
    expect(component).toContain("buttonRefs.current[nextIndex]?.focus()");
    expect(component).toContain("if (tab.flowId === activeFlowId || busyFlowId !== null) return");
  });

  it("uses one solid tokenized focus treatment and local horizontal overflow", () => {
    const styles = source("src/app/site.css");
    const slice = styles.slice(
      styles.indexOf(".workbook-tabs"),
      styles.indexOf(".studio-variables-slot"),
    );
    expect(slice).toContain("min-height: 44px");
    expect(slice).toContain("overflow-x: auto");
    expect(slice).toContain("outline: 3px solid var(--primary)");
    expect(slice).toContain("var(--ink-panel)");
    expect(slice).toContain("var(--hairline-visible)");
    expect(slice).not.toMatch(/gradient|glow-cyan/);
  });
});
