import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

describe("Studio global navigation wiring", () => {
  const page = source("src/app/build/[flowId]/builder.tsx");
  const modeSwitch = source("src/components/mode-switch.tsx");

  it("routes every same-page exit through one guarded navigation handler", () => {
    expect(page).toContain("const handleStudioNavigation");
    expect(page).toContain('onClick={(event) => interceptStudioNavigation(event, "/")}');
    expect(page).toContain('onClick={(event) => interceptStudioNavigation(event, "/flows")}');
    expect(page).toContain('onNavigate={(href, event) => interceptStudioNavigation(event, href)}');
    expect(page).toContain('onClick={(event) => interceptStudioNavigation(event, "/start")}');
    expect(page).toContain('onClick={(event) => interceptStudioNavigation(event, "/agents")}');
    expect(page.match(/onAuxClick=\{\(event\) => interceptStudioNavigation/g)).toHaveLength(6);
  });

  it("gates impact before references and saves before the one router effect", () => {
    const start = page.indexOf("const handleStudioNavigation");
    const body = page.slice(start, page.indexOf("const interceptStudioNavigation", start));
    expect(body.indexOf("impactActionBlocker()")).toBeLessThan(
      body.indexOf('referenceBlocker("global-navigation")'),
    );
    expect(body.indexOf('referenceBlocker("global-navigation")')).toBeLessThan(
      body.indexOf("studioNavigationCoordinatorRef.current.run({"),
    );
    expect(body).toContain("getCurrentGraph: () => historyRef.current?.graph ?? null");
    expect(body).toContain("saveNow: (snapshot) => saveCoordinatorRef.current!.saveNow(snapshot)");
    expect(body).toContain("navigate: () =>");
    expect(body).toContain("router.push(pending.path)");
    expect(body).toContain("workbookSwitchRef.current !== null");
    const workbookStart = page.indexOf("const handleWorkbookTabActivate");
    const workbook = page.slice(workbookStart, page.indexOf("const handleStudioNavigation", workbookStart));
    expect(workbook).toContain("studioNavigationCoordinatorRef.current.isBusy()");
    expect(workbook).toContain("studioNavigationCoordinatorRef.current.run({");
    expect(workbook).toContain("getCurrentGraph: () => historyRef.current?.graph ?? null");
    expect(workbook).toContain("beforeNavigate: pasteNavigationBlocker");
    expect(workbook).not.toContain("saveBeforeWorkbookNavigation({");
    expect(workbook).toContain("pasteNavigationBlocker()");
    expect(body).toContain("pasteNavigationBlocker()");
    expect(body).toContain("beforeNavigate: pasteNavigationBlocker");
    expect(body.indexOf("impactActionBlocker()")).toBeLessThan(body.indexOf("pasteNavigationBlocker()"));
    expect(body.indexOf("pasteNavigationBlocker()")).toBeLessThan(
      body.indexOf('referenceBlocker("global-navigation")'),
    );
    expect(workbook.indexOf("impactActionBlocker()")).toBeLessThan(workbook.indexOf("pasteNavigationBlocker()"));
    expect(workbook.indexOf("pasteNavigationBlocker()")).toBeLessThan(
      workbook.indexOf('referenceBlocker("workbook-navigation")'),
    );
    const pasteGate = page.slice(page.indexOf("const pasteNavigationBlocker"), page.indexOf("const cancelPendingPaste"));
    for (const evidence of [
      "pendingPasteOperationRef.current",
      "pendingPasteEpochGuardRef.current!.hasActiveOperation()",
      "pendingPasteControllerRef.current!.hasActivePlan()",
      "deferredPasteTokenRef.current !== null",
      "pasteResolving",
    ]) expect(pasteGate).toContain(evidence);
  });

  it("records creation immediately but replaces the route only after persisted recovery migration", () => {
    const created = page.slice(page.indexOf("onCreated:"), page.indexOf("onSavingChange:"));
    expect(created).toContain("pendingStudioNavigationRef.current");
    expect(created).toContain("createdRowAwaitingPersistRef.current = rowId");
    expect(created).toContain("pending.createdRowId = rowId");
    expect(created).toContain("resolveStudioNavigationPathAfterCreate(pending.path, rowId)");
    expect(created).not.toContain("router.replace");

    const persistedStart = page.indexOf("onPersisted:");
    const persisted = page.slice(persistedStart, page.indexOf("SAVE_DEBOUNCE_MS,", persistedStart));
    expect(persisted).toContain("pendingCreatedMigrationRef.current = {");
    expect(persisted).toContain("finishCreatedMigrationRef.current()");
    const migration = page.slice(page.indexOf("const finishCreatedMigration"), page.indexOf("const commandContext"));
    expect(migration).toContain('outcome === "stored"');
    expect(migration).toContain("recoveryBindingAfterMigration(");
    expect(migration.indexOf('if (outcome !== "stored")')).toBeLessThan(
      migration.indexOf("router.replace(`/build/${encodeURIComponent(migration.rowId)}`)"),
    );
    expect(page).toContain("const authoritativePath = `/build/${encodeURIComponent(createdRowId)}`");
    expect(page).toContain("beginRouteEffectRef.current(() => router.replace(authoritativePath))");
    expect(page).toContain("const restoreCreatedFlowRoute");
    expect(page).toContain("studioNavigationCoordinatorRef.current.run({");
    expect(page).toContain("saveNow: (snapshot) => saveCoordinatorRef.current!.saveNow(snapshot)");
  });

  it("does not let a paste start inside either navigation save window", () => {
    const start = page.indexOf("const tryStartPendingPaste");
    const body = page.slice(start, page.indexOf("const commitPlainPaste", start));
    expect(body).toContain("studioNavigationCoordinatorRef.current.isBusy()");
    expect(body).toContain("workbookSwitchRef.current !== null");
    expect(body).toContain("STUDIO_NAVIGATION_PASTE_WAIT_MESSAGE");
  });

  it("publishes stable blocker, busy, changed, and save-failure announcements", () => {
    expect(page).toContain("Saving the current draft before leaving.");
    expect(page).toContain("A navigation save is already in progress.");
    expect(page).toContain("STUDIO_NAVIGATION_CHANGED_MESSAGE");
    expect(page).toContain("Could not leave because the current draft did not save.");
    expect(page).toContain("STUDIO_PASTE_NAVIGATION_MESSAGE");
    expect(page).toContain("STUDIO_ALTERNATE_NAVIGATION_MESSAGE");
    expect(page.indexOf('id="studio-reference-save-status"')).toBeLessThan(
      page.indexOf('className="studio-desktop-only studio-header"'),
    );
  });

  it("keeps ModeSwitch links but intercepts every enabled non-active exit", () => {
    expect(modeSwitch).toContain("onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void");
    expect(modeSwitch).toContain("encodeURIComponent(flowId)");
    expect(modeSwitch).toContain("if (isActive)");
    expect(modeSwitch).toContain('aria-current="page"');
    expect(modeSwitch).toContain("event.preventDefault()");
    expect(modeSwitch).toContain("onAuxClick");
    expect(modeSwitch).toContain("onNavigate(href, event)");
  });
});
