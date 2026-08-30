import { describe, it, expect } from "vitest";
import { buildReviewCards } from "@/lib/guided/review";
import type { AgentManifest } from "@/lib/manifest/schema";

function baseManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    manifestVersion: 1,
    name: "Price Watcher",
    description: "Watches a product page and alerts on price drops.",
    triggers: [{ kind: "paidCall", priceUsdc: 0.25 }],
    steps: [
      { id: "n1", type: "llm", config: { prompt: "Extract price" }, after: [] },
      { id: "n2", type: "output", config: {}, after: ["n1"] },
    ],
    meta: {},
    ...overrides,
  };
}

describe("buildReviewCards", () => {
  it("returns four labeled cards in order: what, when, charges, money", () => {
    const cards = buildReviewCards(baseManifest());
    const labels = cards.map((c) => c.label);
    expect(labels).toEqual(["What it does", "When it runs", "What it charges", "Where the money goes"]);
  });

  it("schedule trigger renders cadence string in When it runs", () => {
    const manifest = baseManifest({
      triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
    });
    const cards = buildReviewCards(manifest);
    const when = cards.find((c) => c.label === "When it runs")!;
    expect(when.value).toContain("9");
    expect(when.value).toContain("UTC");
  });

  it("paidCall trigger renders price in What it charges", () => {
    const cards = buildReviewCards(baseManifest());
    const charges = cards.find((c) => c.label === "What it charges")!;
    expect(charges.value).toContain("$0.25");
    expect(charges.value).toContain("per call");
  });

  it("manual trigger shows on-demand in When it runs", () => {
    const manifest = baseManifest({ triggers: [{ kind: "manual" }] });
    const when = buildReviewCards(manifest).find((c) => c.label === "When it runs")!;
    expect(when.value.toLowerCase()).toContain("on demand");
  });

  it("webhook trigger shows on webhook in When it runs", () => {
    const manifest = baseManifest({ triggers: [{ kind: "webhook" }] });
    const when = buildReviewCards(manifest).find((c) => c.label === "When it runs")!;
    expect(when.value.toLowerCase()).toContain("webhook");
  });

  it("no paidCall trigger shows free in What it charges", () => {
    const manifest = baseManifest({ triggers: [{ kind: "manual" }] });
    const charges = buildReviewCards(manifest).find((c) => c.label === "What it charges")!;
    expect(charges.value.toLowerCase()).toContain("free");
  });

  it("payoutAddress shows wallet ending in Where the money goes", () => {
    const manifest = baseManifest({ payoutAddress: "0xb5a0000000000000000000000000000000000032d" });
    const money = buildReviewCards(manifest).find((c) => c.label === "Where the money goes")!;
    expect(money.value).toContain("032d");
  });

  it("no payoutAddress states plainly that no wallet is on file yet", () => {
    // Deliberate copy change (2026-08-09): the old fallback claimed payouts go
    // to a "workspace wallet", but with no saved wallet resolvePayout routes
    // to the platform fallback and the creator collects nothing. The honest
    // line names the gap and the fix.
    const cards = buildReviewCards(baseManifest());
    const money = cards.find((c) => c.label === "Where the money goes")!;
    expect(money.value).toContain("No payout wallet yet");
    expect(money.value).not.toContain("workspace wallet");
  });

  it("What it does returns the manifest description when present", () => {
    const cards = buildReviewCards(baseManifest());
    const what = cards.find((c) => c.label === "What it does")!;
    expect(what.value).toContain("Watches a product page");
  });

  it("What it does falls back to name when description is empty", () => {
    const manifest = baseManifest({ description: "" });
    const what = buildReviewCards(manifest).find((c) => c.label === "What it does")!;
    expect(what.value).toContain("Price Watcher");
  });
});
