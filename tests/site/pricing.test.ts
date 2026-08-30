import { describe, expect, it } from "vitest";
import { gatewayCostUsdc } from "@/lib/billing";
import {
  CALL_OVERHEAD_TOKENS,
  CHARS_PER_TOKEN,
  deriveSiteAgentPricing,
  estimateCallTokens,
  resolveSiteAgentPriceUsdc,
  SITE_AGENT_PRICE_MARGIN,
} from "@/lib/site/pricing";

describe("estimateCallTokens", () => {
  it("matches the live calibration point", () => {
    // A real production call on 2026-07-26: 26,959-char system prompt billed
    // 8,045 tokens. The estimate must land close (within ~5%), never at the
    // old static assumption that ignored prompt size entirely.
    const estimated = estimateCallTokens(26_959);
    expect(estimated).toBe(Math.ceil(26_959 / CHARS_PER_TOKEN) + CALL_OVERHEAD_TOKENS);
    expect(Math.abs(estimated - 8_045) / 8_045).toBeLessThan(0.05);
  });

  it("never returns less than the fixed call overhead", () => {
    expect(estimateCallTokens(0)).toBe(CALL_OVERHEAD_TOKENS);
    expect(estimateCallTokens(-50)).toBe(CALL_OVERHEAD_TOKENS);
  });
});

describe("deriveSiteAgentPricing", () => {
  it("floors at the metered cost, rounded up to the cent", () => {
    const pricing = deriveSiteAgentPricing(24_000, 0.05);

    expect(pricing.estimatedCostUsdc).toBeCloseTo(gatewayCostUsdc(pricing.estimatedTokens), 6);
    expect(pricing.floorUsdc).toBeGreaterThanOrEqual(pricing.estimatedCostUsdc);
    expect(pricing.floorUsdc - pricing.estimatedCostUsdc).toBeLessThan(0.01);
    expect(Math.round(pricing.floorUsdc * 100)).toBeCloseTo(pricing.floorUsdc * 100);
  });

  it("suggests cost plus margin for a full-size site read", () => {
    // ~24k chars of knowledge -> ~$0.078 metered -> $0.12 suggested at 50%.
    const pricing = deriveSiteAgentPricing(24_000, 0.05);

    expect(pricing.suggestedUsdc).toBeGreaterThanOrEqual(
      pricing.estimatedCostUsdc * (1 + SITE_AGENT_PRICE_MARGIN) - 0.01,
    );
    expect(pricing.suggestedUsdc).toBe(0.12);
  });

  it("keeps the blueprint minimum for a tiny site", () => {
    const pricing = deriveSiteAgentPricing(1_000, 0.08);

    expect(pricing.suggestedUsdc).toBe(0.08);
    expect(pricing.floorUsdc).toBeLessThan(0.08);
  });

  it("is monotonic: more baked-in text never gets cheaper", () => {
    let previous = 0;
    for (const chars of [0, 4_000, 12_000, 24_000, 45_000]) {
      const { suggestedUsdc } = deriveSiteAgentPricing(chars, 0.05);
      expect(suggestedUsdc).toBeGreaterThanOrEqual(previous);
      previous = suggestedUsdc;
    }
  });
});

describe("resolveSiteAgentPriceUsdc", () => {
  const pricing = deriveSiteAgentPricing(24_000, 0.05);

  it("uses the derived suggestion when the owner names no price", () => {
    expect(resolveSiteAgentPriceUsdc(undefined, pricing)).toBe(pricing.suggestedUsdc);
  });

  it("honours an owner price above the floor", () => {
    expect(resolveSiteAgentPriceUsdc(0.5, pricing)).toBe(0.5);
  });

  it("clamps below-cost asks to the floor — free is not available", () => {
    // The defect this exists for: the original static $0.02 default lost
    // ~$0.07 of metered model cost on every call to a full-size site agent.
    expect(resolveSiteAgentPriceUsdc(0, pricing)).toBe(pricing.floorUsdc);
    expect(resolveSiteAgentPriceUsdc(0.02, pricing)).toBe(pricing.floorUsdc);
  });
});
