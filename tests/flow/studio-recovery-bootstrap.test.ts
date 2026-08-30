import { describe, expect, it } from "vitest";
import {
  resolveStudioRecoveryRouteIdentity,
  recoveryBindingAfterMigration,
  runStudioTransitionMutation,
  studioTransitionBlocked,
  studioRecoveryBootstrapReady,
} from "@/lib/flow/studio-recovery-bootstrap";

describe("studio recovery bootstrap decisions", () => {
  it("prefers an owner-late persisted row over the initial new route", () => {
    const identity = resolveStudioRecoveryRouteIdentity({
      persistedRowId: "created-row",
      sessionNonce: "nonce_abcdefghijkl",
      template: "lead-qualifier",
      authoritativeFingerprint: "a".repeat(64),
    });
    expect(identity.persisted).toBe(true);
    expect(identity.baseSavedFingerprint).toBe("a".repeat(64));
  });

  it("gives blank and template drafts isolated stable scopes with a null server baseline", () => {
    const blank = resolveStudioRecoveryRouteIdentity({
      persistedRowId: null,
      sessionNonce: "nonce_abcdefghijkl",
      template: null,
      authoritativeFingerprint: "a".repeat(64),
    });
    const template = resolveStudioRecoveryRouteIdentity({
      persistedRowId: null,
      sessionNonce: "nonce_abcdefghijkl",
      template: "lead-qualifier",
      authoritativeFingerprint: "b".repeat(64),
    });
    expect(blank.routeScope).not.toBe(template.routeScope);
    expect(blank.baseSavedFingerprint).toBeNull();
    expect(template.baseSavedFingerprint).toBeNull();
    expect(resolveStudioRecoveryRouteIdentity({
      persistedRowId: null,
      sessionNonce: "nonce_abcdefghijkl",
      template: "lead-qualifier",
      authoritativeFingerprint: "c".repeat(64),
    }).routeScope).toBe(template.routeScope);
  });

  it("blocks mutations before work starts throughout physical history traversal", () => {
    expect(studioTransitionBlocked({ navigationBusy: false, workbookSwitching: false, historyTraversal: true })).toBe(true);
    expect(studioTransitionBlocked({ navigationBusy: true, workbookSwitching: false, historyTraversal: false })).toBe(true);
    expect(studioTransitionBlocked({ navigationBusy: false, workbookSwitching: true, historyTraversal: false })).toBe(true);
    expect(studioTransitionBlocked({ navigationBusy: false, workbookSwitching: false, historyTraversal: false })).toBe(false);
    let mutations = 0;
    expect(runStudioTransitionMutation(
      { navigationBusy: false, workbookSwitching: false, historyTraversal: true },
      () => { mutations += 1; },
    ).status).toBe("blocked");
    expect(mutations).toBe(0);
    expect(runStudioTransitionMutation(
      { navigationBusy: false, workbookSwitching: false, historyTraversal: false },
      () => { mutations += 1; },
    ).status).toBe("applied");
    expect(mutations).toBe(1);
  });

  it("restores both storage key and route scope after a failed rekey", () => {
    const previous = { storageKey: "new-key", routeScope: "new-scope" };
    const next = { storageKey: "row-key", routeScope: "row-scope" };
    expect(recoveryBindingAfterMigration(false, previous, next)).toEqual(previous);
    expect(recoveryBindingAfterMigration(true, previous, next)).toEqual(next);
  });

  it("keeps bootstrap closed until both owner and authoritative graph are ready", () => {
    expect(studioRecoveryBootstrapReady({ ownerScopeHash: null, authoritativeReady: true })).toBe(false);
    expect(studioRecoveryBootstrapReady({ ownerScopeHash: "owner", authoritativeReady: false })).toBe(false);
    expect(studioRecoveryBootstrapReady({ ownerScopeHash: "owner", authoritativeReady: true })).toBe(true);
  });
});
