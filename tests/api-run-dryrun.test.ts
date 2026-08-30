/**
 * Regression: App Store Guideline 2.1 rejection of "Suede Agents: AI That Earns".
 *
 * The iOS app's "Run Agent" is a FREE dry-run preview, but the live endpoint
 * returned HTTP 402 (x402 "payment required") for the unpaid call — so the core
 * action failed in review. Fix: an explicit dry-run request bypasses the x402
 * paywall and runs free (settled:false), EVEN for a live, priced agent, while a
 * normal machine call to a live agent still settles via x402.
 *
 * The dry-run DECISION logic is unit-tested here. The wired route is verified
 * end-to-end with a live curl against the deployed endpoint — this repo's
 * convention is to not import route handlers into vitest, because they pull
 * server-only deps (`jose`, `@ai-sdk/openai`) the test runner can't resolve.
 */
import { describe, it, expect } from "vitest";
import { isDryRunRequested, resolveRunMode } from "@/lib/run-mode";

describe("resolveRunMode — an explicit dry-run request always wins", () => {
  it("forces dry-run when requested, even when global + agent are live", () => {
    expect(resolveRunMode({ requestedDryRun: true, globalLive: true, agentSettlementLive: true }).dryRun).toBe(true);
  });
  it("settles (not dry-run) for a live priced call with no dry-run request", () => {
    expect(resolveRunMode({ requestedDryRun: false, globalLive: true, agentSettlementLive: true }).dryRun).toBe(false);
  });
  it("dry-runs when the platform is not globally live", () => {
    expect(resolveRunMode({ requestedDryRun: false, globalLive: false, agentSettlementLive: true }).dryRun).toBe(true);
  });
  it("dry-runs when the agent opted out of settlement", () => {
    expect(resolveRunMode({ requestedDryRun: false, globalLive: true, agentSettlementLive: false }).dryRun).toBe(true);
  });
});

describe("isDryRunRequested — body flag, query param, or header", () => {
  const headers = (o?: Record<string, string>): Headers => new Headers(o);
  it("true from body.dryRun", () => {
    expect(isDryRunRequested(new URL("https://x/run"), headers(), { dryRun: true })).toBe(true);
  });
  it("true from ?dryRun=1", () => {
    expect(isDryRunRequested(new URL("https://x/run?dryRun=1"), headers(), {})).toBe(true);
  });
  it("true from ?dryRun=true", () => {
    expect(isDryRunRequested(new URL("https://x/run?dryRun=true"), headers(), {})).toBe(true);
  });
  it("true from the x-suede-dry-run header", () => {
    expect(isDryRunRequested(new URL("https://x/run"), headers({ "x-suede-dry-run": "1" }), {})).toBe(true);
  });
  it("false with no signal", () => {
    expect(isDryRunRequested(new URL("https://x/run"), headers(), {})).toBe(false);
  });
  it("ignores a non-true body value", () => {
    expect(isDryRunRequested(new URL("https://x/run"), headers(), { dryRun: "yes" })).toBe(false);
  });
});
