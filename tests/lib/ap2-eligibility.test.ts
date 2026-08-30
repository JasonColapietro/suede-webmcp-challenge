import { describe, expect, it } from "vitest";

import { isAp2ServiceEligible } from "@/lib/rails/ap2-eligibility";

describe("AP2 service eligibility", () => {
  it("requires a paid immutable Live service with cent-exact pricing", () => {
    expect(isAp2ServiceEligible({
      priceUsdc: 0.25,
      acceptsPayment: true,
      publishedLive: true,
      fulfillmentSupportsAp2: true,
    })).toBe(true);
    for (const input of [
      { priceUsdc: 0.001, acceptsPayment: true, publishedLive: true, fulfillmentSupportsAp2: true },
      { priceUsdc: 0, acceptsPayment: true, publishedLive: true, fulfillmentSupportsAp2: true },
      { priceUsdc: 0.25, acceptsPayment: false, publishedLive: true, fulfillmentSupportsAp2: true },
      { priceUsdc: 0.25, acceptsPayment: true, publishedLive: false, fulfillmentSupportsAp2: true },
      { priceUsdc: Number.NaN, acceptsPayment: true, publishedLive: true, fulfillmentSupportsAp2: true },
    ]) {
      expect(isAp2ServiceEligible(input)).toBe(false);
    }
  });

  it("rejects fulfillment paths without idempotent AP2 delivery", () => {
    expect(isAp2ServiceEligible({
      priceUsdc: 1,
      acceptsPayment: true,
      publishedLive: true,
      fulfillmentSupportsAp2: false,
    })).toBe(false);
  });
});
