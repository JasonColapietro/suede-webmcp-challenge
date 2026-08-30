import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("project version UI source contracts", () => {
  it("keeps client components away from repository and service modules", () => {
    const clientSource = [
      source("src/app/flows/dashboard.tsx"),
      source("src/app/build/[flowId]/builder.tsx"),
      source("src/components/projects/VersionPanel.tsx"),
      source("src/components/projects/ProjectContext.tsx"),
      source("src/components/projects/EnvironmentBadge.tsx"),
    ].join("\n");
    expect(clientSource).not.toMatch(
      /@\/lib\/projects\/(?:provider|repo|sqlite-project-repo|version-service)/,
    );
  });

  it("renders an ordered, labelled, live-announced version ledger", () => {
    const panel = source("src/components/projects/VersionPanel.tsx");
    expect(panel).toContain('<ol className="version-ledger"');
    expect(panel).toContain('aria-label="Saved versions, newest first"');
    expect(panel).toContain('aria-live="polite"');
    expect(panel).toContain("model.showSave && onSave");
    expect(panel.indexOf("</details>")).toBeLessThan(panel.indexOf("model.showSave && onSave"));
    expect(panel).toContain('<button type="button" className="version-ledger__review"');
    expect(panel).toContain("item.label");
    expect(panel).toContain("item.description");
  });

  it("keeps mobile version history read-only and desktop controls unfocusable", () => {
    const studio = source("src/app/build/[flowId]/builder.tsx");
    const styles = source("src/app/site.css");
    const mobile = studio.slice(studio.indexOf('<div className="studio-mobile-guard">'));
    expect(mobile).toContain("<VersionPanel");
    expect(mobile).toContain("readOnly");
    expect(mobile).not.toContain("onSave=");
    expect(mobile).not.toContain("onReview=");
    expect(mobile).toContain("setForceCompactCanvas(true)");
    expect(studio).toContain('className={forceCompactCanvas ? "studio-shell studio-force-canvas" : "studio-shell"}');
    expect(studio).toContain('key={forceCompactCanvas ? "compact-canvas-open" : "canvas"}');
    expect(styles).toMatch(/@media \(max-width: 1279px\)[\s\S]*\.studio-desktop-only[\s\S]*display: none !important/);
    expect(styles).toContain(".studio-shell:not(.studio-force-canvas) > .studio-desktop-only");
    expect(styles).toContain("@media (min-width: 760px) and (max-width: 1279px)");
    expect(styles).toMatch(/@media \(max-width: 1279px\)[\s\S]*minmax\(280px, 34vw\)/);
    expect(styles).toMatch(/\.studio-mobile-guard[\s\S]*overflow-y: auto/);
  });

  it("wires selected-only private review reads, abort guards, and strictly separate promotions", () => {
    const studio = source("src/app/build/[flowId]/builder.tsx");
    expect(studio).toContain("parseVersionDiffEnvelope");
    expect(studio).toContain("parseVersionRestoreEnvelope");
    expect(studio).toContain("parseDeploymentsEnvelope");
    expect(studio).toContain("new AbortController()");
    expect(studio).toContain("versionReviewGenerationRef");
    expect(studio).toContain("/versions/compare?");
    expect(studio).toContain('confirmation: "PROMOTE TEST"');
    expect(studio).toContain('confirmation: "PROMOTE LIVE"');
    expect(studio).toContain("sourceTestDeploymentId: activeTestDeployment.id");
    expect(studio).toContain("handleRestoreVersion(selectedVersion.id, operation)");
    expect(studio).toContain("versionReviewEnvelopeMatches");
    expect(studio).not.toMatch(/setVersionAnnouncement\([^)]*(?:response|error\.message|reason)/);
  });

  it("owns every project-state load and mutation write by generation, row, and controller", () => {
    const studio = source("src/app/build/[flowId]/builder.tsx");
    const load = studio.slice(studio.indexOf("const loadProjectState"), studio.indexOf("// --- Persistence"));
    expect(load).toContain("claimLatestRequest(projectLoadSlotRef.current");
    expect(load).toContain("controller.signal");
    expect(load).toContain("ownsRequest(projectLoadSlotRef.current");
    expect(load.match(/commitProjectLoad\(\(\) =>/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(studio).toContain("claimExclusiveRequest(versionMutationSlotRef.current");
    expect(studio).toContain("releaseRequest(versionMutationSlotRef.current, operation)");
    expect(studio).toContain("abandonVersionReviewSession({");
    expect(studio).toContain("return () => abandonVersionReviewSession");
  });

  it("keeps the three environment states visible on both Studio surfaces", () => {
    const studio = source("src/app/build/[flowId]/builder.tsx");
    const context = source("src/components/projects/ProjectContext.tsx");
    expect(context).toContain('aria-label="Environment status"');
    expect(context).toContain("Mutable workspace");
    expect(context).toContain("Not promoted");
    expect(context).toContain("Checking…");
    expect(context).toContain("Unavailable");
    expect(studio.match(/deploymentHistory=/g)).toHaveLength(2);
  });

  it("uses the persisted row id and a guarded exact atomic graph checkpoint", () => {
    const studio = source("src/app/build/[flowId]/builder.tsx");
    const handler = studio.slice(
      studio.indexOf("const handleSaveVersion"),
      studio.indexOf("const handleRestoreVersion"),
    );
    expect(handler).toContain("rowId: persistedId");
    expect(handler).toContain("createCheckpoint: async (rowId, current)");
    expect(handler).toContain("encodeURIComponent(rowId)");
    expect(handler).toContain("body: JSON.stringify({ graph: current })");
    expect(handler).toContain("const versionGraph = structuredClone(graph)");
    expect(handler).toContain("const versionFingerprint = flowSaveFingerprint(versionGraph)");
    expect(handler.indexOf("saveNow(versionGraph)")).toBeLessThan(
      handler.indexOf("saveVersionCheckpoint({"),
    );
    expect(handler.indexOf("saveNow(versionGraph)")).toBeLessThan(
      handler.indexOf("flowSaveFingerprint(currentGraph) !== versionFingerprint"),
    );
    expect(handler.indexOf("flowSaveFingerprint(currentGraph) !== versionFingerprint")).toBeLessThan(
      handler.indexOf("saveVersionCheckpoint({"),
    );
    expect(handler).toContain("graph: versionGraph");
    expect(handler).not.toMatch(/launch|deploy|settle|gateway/i);
  });

  it("blocks delete while version history is unknown or nonempty", () => {
    const flows = source("src/app/flows/dashboard.tsx");
    expect(flows).toContain("Checking saved versions before delete is available.");
    expect(flows).toContain("Version status unavailable. Retry metadata before deleting.");
    expect(flows).toContain("deleteFlowControl(versionCounts[f.id] ?? 0).disabled");
    expect(flows).toContain("href={`/build/${f.id}`}");
  });

  it("shows the editable draft badge only once in Code", () => {
    const code = source("src/app/code/[flowId]/page.tsx");
    expect(code).toContain('<EnvironmentBadge kind="draft" />');
    expect(code).not.toMatch(/<ProjectContext[\s\S]{0,180}showEnvironment/);
  });

  it("uses a solid primary focus indicator on every Task 7 interactive control", () => {
    const styles = source("src/app/site.css");
    const focusRule = styles.slice(
      styles.indexOf(".project-metadata-retry:focus-visible"),
      styles.indexOf(".lp-row-delete-note"),
    );
    expect(focusRule).toContain(".version-panel__action:focus-visible");
    expect(focusRule).toContain(".version-panel__save:focus-visible");
    expect(focusRule).toContain(".version-panel__summary:focus-visible");
    expect(focusRule).toContain(".version-download:focus-visible");
    expect(focusRule).toContain("outline: 3px solid var(--primary)");
    expect(focusRule).toContain("outline-offset: 2px");
    expect(focusRule).not.toContain("var(--glow-cyan)");
    expect(focusRule).not.toContain(".lp-iconbtn:focus-visible");
  });

  it("announces one context update per visible surface without row-level live spam", () => {
    const context = source("src/components/projects/ProjectContext.tsx");
    const flows = source("src/app/flows/dashboard.tsx");
    expect(context).toContain("readonly announce?: boolean");
    expect(context).toContain('role={announce ? "status" : undefined}');
    expect(context).toContain('aria-live={announce ? "polite" : undefined}');
    expect(context).toContain("aria-atomic={announce || undefined}");
    expect(context).not.toContain('role="alert"');
    expect(flows).toContain("announce={false}");
  });

  it("uses the strict minimal workbook projection for bound Studio flows", () => {
    const studio = source("src/app/build/[flowId]/builder.tsx");
    const context = source("src/components/projects/ProjectContext.tsx");
    const model = source("src/lib/projects/ui-model.ts");
    expect(context).toContain("FlowWorkbookContext | null");
    expect(context).not.toContain("PersonalContext");
    expect(model).toContain('export { parseFlowWorkbookEnvelope } from "@/lib/projects/public-workbook"');
    expect(studio).toContain("parseFlowWorkbookEnvelope");
    expect(studio).toContain("setProjectContext(contextResult.value.context)");
    expect(studio).toContain("setWorkbookTabs(contextResult.value.tabs)");
  });
});
