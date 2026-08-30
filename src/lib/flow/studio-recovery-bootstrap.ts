import {
  studioRecoveryNewRouteScope,
  studioRecoveryPersistedRouteScope,
} from "./studio-recovery";

export interface StudioRecoveryRouteIdentity {
  readonly routeScope: string;
  readonly persisted: boolean;
  readonly baseSavedFingerprint: string | null;
}

export interface StudioRecoverySlotBinding {
  readonly storageKey: string | null;
  readonly routeScope: string | null;
}

export function recoveryBindingAfterMigration(
  stored: boolean,
  previous: StudioRecoverySlotBinding,
  next: StudioRecoverySlotBinding,
): StudioRecoverySlotBinding {
  return stored ? next : previous;
}

export function studioRecoveryBootstrapReady(input: {
  readonly ownerScopeHash: string | null;
  readonly authoritativeReady: boolean;
}): boolean {
  return input.ownerScopeHash !== null && input.authoritativeReady;
}

export function resolveStudioRecoveryRouteIdentity(input: {
  readonly persistedRowId: string | null;
  readonly sessionNonce: string;
  readonly template: string | null;
  readonly authoritativeFingerprint: string;
}): StudioRecoveryRouteIdentity {
  if (input.persistedRowId !== null) {
    return {
      routeScope: studioRecoveryPersistedRouteScope(input.persistedRowId),
      persisted: true,
      baseSavedFingerprint: input.authoritativeFingerprint,
    };
  }
  return {
    routeScope: studioRecoveryNewRouteScope(`${input.sessionNonce}\0${input.template ?? ""}`),
    persisted: false,
    baseSavedFingerprint: null,
  };
}

export function studioTransitionBlocked(input: {
  readonly navigationBusy: boolean;
  readonly workbookSwitching: boolean;
  readonly historyTraversal: boolean;
}): boolean {
  return input.navigationBusy || input.workbookSwitching || input.historyTraversal;
}

export function runStudioTransitionMutation<T>(
  input: Parameters<typeof studioTransitionBlocked>[0],
  mutation: () => T,
): { readonly status: "blocked" } | { readonly status: "applied"; readonly value: T } {
  if (studioTransitionBlocked(input)) return { status: "blocked" };
  return { status: "applied", value: mutation() };
}
