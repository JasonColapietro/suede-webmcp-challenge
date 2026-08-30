// tests/promo-output.test.ts
import { describe, it, expect } from "vitest";
import { parsePromoOutput } from "@/lib/promo-output";

/**
 * Regression coverage for the shape mismatch that made the "View Campaign" card
 * on /a/[slug] never render: the engine persists node outputs keyed by PORT
 * (`{ campaign: { ... } }`), but both repos read `campaignUrl` off the top level.
 */
describe("parsePromoOutput", () => {
  // This is byte-for-byte what run-service writes for a suede.promo step:
  // `output: event.outputs`, where promoNode returns `outputs.campaign`.
  const engineShape = {
    campaign: {
      campaignId: "72ebb90c-509c-415e-9fe7-90fe09a84889",
      campaignUrl: "https://promo.suedeai.ai/c/72ebb90c-509c-415e-9fe7-90fe09a84889",
      name: "Suede Promo creator profile push",
    },
  };

  it("reads the port-keyed shape the engine actually writes", () => {
    expect(parsePromoOutput(engineShape)).toEqual({
      campaignId: "72ebb90c-509c-415e-9fe7-90fe09a84889",
      campaignUrl: "https://promo.suedeai.ai/c/72ebb90c-509c-415e-9fe7-90fe09a84889",
      name: "Suede Promo creator profile push",
    });
  });

  it("reads the same shape when stored as a JSON string (sqlite rows)", () => {
    expect(parsePromoOutput(JSON.stringify(engineShape))).toEqual({
      campaignId: "72ebb90c-509c-415e-9fe7-90fe09a84889",
      campaignUrl: "https://promo.suedeai.ai/c/72ebb90c-509c-415e-9fe7-90fe09a84889",
      name: "Suede Promo creator profile push",
    });
  });

  it("still reads a flat shape, so pre-existing or hand-written rows resolve", () => {
    expect(
      parsePromoOutput({
        campaignId: "abc",
        campaignUrl: "https://promo.suedeai.ai/c/abc",
        name: "Flat",
      }),
    ).toEqual({
      campaignId: "abc",
      campaignUrl: "https://promo.suedeai.ai/c/abc",
      name: "Flat",
    });
  });

  it("handles the dry-run stub the node emits", () => {
    const result = parsePromoOutput({
      campaign: {
        campaignId: "dry-run",
        campaignUrl: "https://promo.suedeai.ai/c/dry-run",
        name: "Test campaign",
      },
    });
    expect(result?.campaignUrl).toBe("https://promo.suedeai.ai/c/dry-run");
  });

  it("defaults a missing name rather than returning null", () => {
    const result = parsePromoOutput({
      campaign: { campaignUrl: "https://promo.suedeai.ai/c/x" },
    });
    expect(result).toEqual({
      campaignId: "",
      campaignUrl: "https://promo.suedeai.ai/c/x",
      name: "Promo Campaign",
    });
  });

  it("returns null for outputs with no usable campaign URL", () => {
    expect(parsePromoOutput({ campaign: { campaignId: "x" } })).toBeNull();
    expect(parsePromoOutput({ campaign: { campaignUrl: "" } })).toBeNull();
    expect(parsePromoOutput({ campaign: { campaignUrl: 42 } })).toBeNull();
    expect(parsePromoOutput({ other: { campaignUrl: "https://x" } })).toBeNull();
  });

  it("never throws on malformed input", () => {
    for (const bad of [null, undefined, "", "not json", "{oops", 7, [], [1, 2], true]) {
      expect(() => parsePromoOutput(bad)).not.toThrow();
      expect(parsePromoOutput(bad)).toBeNull();
    }
  });
});
