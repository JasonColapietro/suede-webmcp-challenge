/**
 * The per-target-agent preview ceiling.
 *
 * Two properties matter and pull against each other: a machine loop against one
 * agent must be stopped, and the free human preview must stay open. The second
 * is load-bearing — it is why the App Store 2.1 rejection was resolved — so the
 * headroom assertions here are as much the point as the refusal one.
 */
import { describe, it, expect } from "vitest";
import {
  checkPreviewBudget,
  PREVIEW_BUDGET,
  previewBudgetKey,
} from "@/lib/webmcp/preview-budget";

/** Unique slug per test: buckets are process-global and keyed by slug. */
let n = 0;
const slug = (): string => `agent-${(n += 1)}-${Math.random().toString(36).slice(2)}`;

describe("preview budget", () => {
  it("keys the bucket per agent, not per caller", () => {
    expect(previewBudgetKey("contract-review")).toBe("preview:contract-review");
  });

  it("does not let two agents share one ceiling", () => {
    const a = slug();
    const b = slug();
    const now = 1_000_000;
    for (let i = 0; i < PREVIEW_BUDGET.capacity; i += 1) checkPreviewBudget(a, now);
    expect(checkPreviewBudget(a, now).allowed).toBe(false);
    // Draining agent A must not refuse a first preview of agent B.
    expect(checkPreviewBudget(b, now).allowed).toBe(true);
  });

  it("stops a machine loop hammering one agent", () => {
    const s = slug();
    const now = 2_000_000;
    let refusedAt = -1;
    for (let i = 0; i < PREVIEW_BUDGET.capacity + 10; i += 1) {
      if (!checkPreviewBudget(s, now).allowed) { refusedAt = i; break; }
    }
    expect(refusedAt).toBeGreaterThan(0);
    expect(checkPreviewBudget(s, now)).toMatchObject({ allowed: false });
  });

  it("leaves ample headroom for humans clicking Try it", () => {
    // A burst far beyond any plausible human rate still passes.
    const s = slug();
    const now = 3_000_000;
    for (let i = 0; i < 30; i += 1) {
      expect(checkPreviewBudget(s, now).allowed, `preview ${i}`).toBe(true);
    }
  });

  it("refills over time so a drained agent recovers", () => {
    const s = slug();
    const start = 4_000_000;
    for (let i = 0; i < PREVIEW_BUDGET.capacity; i += 1) checkPreviewBudget(s, start);
    expect(checkPreviewBudget(s, start).allowed).toBe(false);
    // One second later the bucket has refilled refillPerSec tokens.
    expect(checkPreviewBudget(s, start + 1_000).allowed).toBe(true);
  });

  it("reports when to retry rather than refusing blind", () => {
    const s = slug();
    const now = 5_000_000;
    for (let i = 0; i < PREVIEW_BUDGET.capacity; i += 1) checkPreviewBudget(s, now);
    expect(checkPreviewBudget(s, now).retryAfterSec).toBeGreaterThan(0);
  });
});
