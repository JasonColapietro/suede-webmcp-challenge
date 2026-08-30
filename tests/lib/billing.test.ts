/**
 * Pure unit tests for src/lib/billing.ts
 * No I/O, no mocks — purely functional.
 */

import { describe, it, expect } from "vitest";
import {
  PLATFORM_TAKE_RATE,
  GATEWAY_MARGIN,
  COMMIT_GATEWAY_MARGIN,
  COMMIT_TIERS,
  FREE_MONTHLY_GATEWAY_TOKENS,
  splitCall,
  gatewayCostUsdc,
  commitGrantUsdc,
} from "@/lib/billing";

describe("billing constants", () => {
  it("PLATFORM_TAKE_RATE is 0%", () => {
    expect(PLATFORM_TAKE_RATE).toBe(0);
  });

  it("GATEWAY_MARGIN is 20%", () => {
    expect(GATEWAY_MARGIN).toBe(0.2);
  });

  it("FREE_MONTHLY_GATEWAY_TOKENS is 100_000", () => {
    expect(FREE_MONTHLY_GATEWAY_TOKENS).toBe(100_000);
  });
});

describe("splitCall", () => {
  it("creator gets 100% for a $0.25 call", () => {
    const split = splitCall(0.25);
    expect(split.creatorUsdc).toBeCloseTo(0.25, 6);
    expect(split.platformUsdc).toBe(0);
  });

  it("creator + platform sums to the full price", () => {
    const price = 1.0;
    const { creatorUsdc, platformUsdc } = splitCall(price);
    expect(creatorUsdc + platformUsdc).toBeCloseTo(price, 6);
  });

  it("zero-price agent returns zero for both", () => {
    const { creatorUsdc, platformUsdc } = splitCall(0);
    expect(creatorUsdc).toBe(0);
    expect(platformUsdc).toBe(0);
  });

  it("rounds to 6 decimal places", () => {
    // Platform take is 0, so all rounding pressure is on creatorUsdc now.
    const { creatorUsdc } = splitCall(0.0123456789);
    const decimals = creatorUsdc.toString().split(".")[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });

  it("platform always gets PLATFORM_TAKE_RATE fraction", () => {
    for (const price of [0.1, 0.5, 2.0, 10.0]) {
      const { platformUsdc } = splitCall(price);
      expect(platformUsdc / price).toBeCloseTo(PLATFORM_TAKE_RATE, 5);
    }
  });
});

describe("gatewayCostUsdc", () => {
  it("returns 0 for 0 tokens", () => {
    expect(gatewayCostUsdc(0)).toBe(0);
  });

  it("scales linearly with token count", () => {
    const cost1 = gatewayCostUsdc(1000);
    const cost2 = gatewayCostUsdc(2000);
    expect(cost2 / cost1).toBeCloseTo(2, 5);
  });

  it("is positive for positive token counts", () => {
    expect(gatewayCostUsdc(100)).toBeGreaterThan(0);
  });

  it("100k tokens costs more than 1k tokens", () => {
    expect(gatewayCostUsdc(100_000)).toBeGreaterThan(gatewayCostUsdc(1_000));
  });

  it("includes the GATEWAY_MARGIN markup", () => {
    // gatewayCostUsdc should be (1 + 0.2) × base cost
    const cost = gatewayCostUsdc(1_000_000);
    expect(cost).toBeGreaterThan(0.009); // base without markup = 0.009 for 1M tokens
  });
});

describe("committed-use", () => {
  it("COMMIT_GATEWAY_MARGIN is below the pay-as-you-go GATEWAY_MARGIN", () => {
    // The gap between the two IS the commitment discount; a commit margin that
    // wasn't lower would grant no bonus.
    expect(COMMIT_GATEWAY_MARGIN).toBeLessThan(GATEWAY_MARGIN);
  });

  it("COMMIT_TIERS is the placeholder 50/100/250 ladder", () => {
    expect(COMMIT_TIERS).toEqual([50, 100, 250]);
  });

  it("grants strictly more than the charge (a real bonus) for every tier", () => {
    for (const tier of COMMIT_TIERS) {
      expect(commitGrantUsdc(tier)).toBeGreaterThan(tier);
    }
  });

  it("derives the multiplier purely from the two margin constants", () => {
    const multiplier = (1 + GATEWAY_MARGIN) / (1 + COMMIT_GATEWAY_MARGIN);
    expect(commitGrantUsdc(100)).toBeCloseTo(100 * multiplier, 6);
  });

  it("scales linearly with the charge", () => {
    // Each tier is independently rounded to 6 decimals, so doubling a rounded
    // $50 grant and the rounded $100 grant can differ by one USDC-precision
    // unit; compare at 5 decimals to assert proportionality, not rounding.
    expect(commitGrantUsdc(100)).toBeCloseTo(commitGrantUsdc(50) * 2, 5);
  });

  it("grants zero for a zero charge", () => {
    expect(commitGrantUsdc(0)).toBe(0);
  });

  it("rounds to at most 6 decimal places (USDC precision)", () => {
    const decimals = commitGrantUsdc(50).toString().split(".")[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });
});
