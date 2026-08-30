import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

describe("durable RunDock source contracts", () => {
  it("passes version resolution state so loading and failure cannot expose legacy Run", () => {
    const page = source("src/app/build/[flowId]/builder.tsx");
    expect(page).toContain("immutableVersionStatus={versionHistory.status}");
    const dock = source("src/components/canvas/RunDock.tsx");
    expect(dock).toContain('immutableVersionStatus !== "ready"');
    expect(dock).toContain("flexShrink: 0");
    expect(dock.indexOf('immutableVersionStatus !== "ready"')).toBeLessThan(dock.indexOf("durableFallbackKey !== durableVersionKey"));
  });

  it("keeps the fixed desktop dock three-column through 760px and collapses run-page content at 900px", () => {
    const styles = source("src/app/globals.css");
    expect(styles).toContain("@media (max-width: 759px)");
    expect(styles).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.durable-run-page-grid \{ grid-template-columns: 1fr; \}/u);
    expect(styles).toContain(".durable-run-page-grid { display: grid; grid-template-columns: 1fr;");
    expect(styles).toContain("min-height: 44px; flex-shrink: 0;");
    expect(styles).not.toContain("outline: 3px solid #818cf8");
    expect(styles).toContain("outline: 3px solid var(--primary)");
    expect(styles).toContain(".legacy-admission-receipt { color: var(--text-warning);");
    expect(styles).not.toContain(".legacy-admission-receipt { color: var(--warning-amber)");
  });
});
