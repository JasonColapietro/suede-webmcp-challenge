import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

describe("workbook tab Studio integration source contract", () => {
  it("keys every editor session by the authoritative route row id", () => {
    const page = source("src/app/build/[flowId]/builder.tsx");
    const shell = page.slice(page.indexOf("export default function BuildPage"), page.indexOf("function BuildSession"));
    expect(shell).toContain("const pendingTabFocusRef = useRef<string | null>(null)");
    expect(shell).toContain("pendingTabFocusRef.current = readStoredWorkbookTabFocus()");
    expect(shell).toContain("const flowId = decodeRouteRowId(params.flowId)");
    expect(shell).toContain("<BuildSession");
    expect(shell).toContain("key={flowId}");
    expect(shell).toContain("flowId={flowId}");
    expect(page.match(/<WorkbookTabs/g)).toHaveLength(1);
    expect(page).toContain("void saveCoordinatorRef.current?.dispose()");
  });

  it("loads authoritative current-flow context and binds saveNow before navigation", () => {
    const page = source("src/app/build/[flowId]/builder.tsx");
    expect(page).toContain("`/api/v2/flows/${encodeURIComponent(flowId)}/workbook`");
    expect(page).toContain("parseFlowWorkbookEnvelope");
    expect(page.indexOf("!isNew")).toBeLessThan(page.indexOf('fetch("/api/v2/context",'));
    expect(page).toContain("saveNow: (snapshot) => saveCoordinatorRef.current!.saveNow(snapshot)");
    expect(page).toContain("beforeNavigate: pasteNavigationBlocker");
    expect(page).toContain("pendingTabFocusRef.current = target.flowId");
    expect(page).toContain("storeWorkbookTabFocus(target.flowId)");
    expect(page).toContain("clearStoredWorkbookTabFocus()");
    expect(page).toContain("Could not switch tabs because the current draft did not save.");
  });

  it("renders the single shared tablist above a static mobile guard", () => {
    const page = source("src/app/build/[flowId]/builder.tsx");
    const styles = source("src/app/site.css");
    // Row 1 is reserved for the optional Guided arrival banner and collapses
    // to 0 when absent; rows 2-5 are pinned below.
    expect(page).toContain('gridTemplateRows: "auto auto auto minmax(0, 1fr) auto"');
    expect(page.indexOf("<WorkbookTabs")).toBeLessThan(page.indexOf('className="studio-mobile-guard"'));
    const mobile = styles.slice(styles.indexOf("/* ---- Studio compact-canvas guard"));
    expect(mobile).toContain("@media (max-width: 1279px)");
    expect(mobile).toMatch(/\.studio-mobile-guard\s*\{[^}]*grid-row:\s*4/s);
    expect(mobile).not.toMatch(/\.studio-mobile-guard\s*\{[^}]*position:\s*fixed/s);
    expect(mobile).not.toMatch(/\.studio-mobile-guard\s*\{[^}]*inset:\s*0/s);
  });

  it("pins every studio chrome row so a banner cannot displace the tab strip", () => {
    // Regression guard: when .studio-header and .studio-context-stack were
    // auto-placed, rendering the Guided arrival banner (/build/<id>?from=guided)
    // pushed them past the definite rows below, and the workbook tab strip
    // rendered underneath the run dock.
    const styles = source("src/app/site.css");
    expect(styles).toMatch(/\.studio-header\s*\{[^}]*grid-row:\s*2/s);
    expect(styles).toMatch(/\.studio-context-stack\s*\{[^}]*grid-row:\s*3/s);
    expect(styles).toMatch(/\.studio-editor-body\s*\{[^}]*grid-row:\s*4/s);
    expect(styles).toMatch(/\.studio-run-dock\s*\{[^}]*grid-row:\s*5/s);
  });

  it("shares only the pending row-id marker across keyed sessions", () => {
    const page = source("src/app/build/[flowId]/builder.tsx");
    expect(page).toContain("pendingTabFocusRef: WorkbookTabFocusHandoff");
    const propShape = page.slice(
      page.indexOf("function BuildSession"),
      page.indexOf("}): React.JSX.Element", page.indexOf("function BuildSession")),
    );
    expect(propShape).not.toMatch(/graph|transport|queue|coordinator/i);
    expect(page).not.toMatch(/saveCoordinatorRef\.current\.(?:persistedId|flowId)\s*=/);
  });
});
