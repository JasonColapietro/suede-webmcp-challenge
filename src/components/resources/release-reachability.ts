import type { ResourceCurrentReleaseSummary } from "./client";

export type ResourceReleaseReachability =
  | { readonly state: "lifecycle"; readonly runnable: false; readonly discoverable: false }
  | { readonly state: "freshness"; readonly runnable: false; readonly discoverable: false }
  | { readonly state: "private"; readonly runnable: false; readonly discoverable: false }
  | { readonly state: "price"; readonly runnable: false; readonly discoverable: false }
  | { readonly state: "payout"; readonly runnable: false; readonly discoverable: false }
  | { readonly state: "settlement"; readonly runnable: false; readonly discoverable: false }
  | { readonly state: "ready"; readonly runnable: true; readonly discoverable: boolean };

/** Derives reachability only from the immutable release receipt and its exact pack freshness. */
export function resourceReleaseReachability(
  release: ResourceCurrentReleaseSummary,
): ResourceReleaseReachability {
  if (release.agentStatus !== "live" || release.deploymentStatus !== "live" ||
      release.deploymentRetiredAt !== null) {
    return { state: "lifecycle", runnable: false, discoverable: false };
  }
  if (release.freshness !== "fresh") {
    return { state: "freshness", runnable: false, discoverable: false };
  }
  if (release.executionAccess === "private") {
    return { state: "private", runnable: false, discoverable: false };
  }
  if (release.executionAccess === "paid") {
    if (release.priceUsdc <= 0) return { state: "price", runnable: false, discoverable: false };
    if (!release.payoutReady) return { state: "payout", runnable: false, discoverable: false };
    if (release.settlementState !== "on") return { state: "settlement", runnable: false, discoverable: false };
  }
  return {
    state: "ready",
    runnable: true,
    discoverable: release.discoveryAccess === "public",
  };
}
