/**
 * Cost-derived pricing for site-drafted agents.
 *
 * A site agent's system prompt carries the crawled site text (~24k chars for
 * a full read), so every call moves ~8k tokens through the metered gateway —
 * about $0.087 at the gateway rate. The original static defaults ($0.02-0.05,
 * copied from the short-prompt template catalog) priced every call ~4x under
 * its own model cost, on a product whose thesis is that agents earn
 * (confirmed live against zingermans.com on 2026-07-26: 8,045 tokens,
 * $0.0869 metered, $0.02 price).
 *
 * So the price is derived from the actual knowledge baked into the prompt:
 *
 *   floor   = gateway cost of one estimated call, rounded up to the cent —
 *             the hard minimum; no override may go below it.
 *   default = floor cost x (1 + margin), still never below the blueprint's
 *             "from" price.
 *
 * Pure arithmetic over billing.ts constants. No network, no node builtins —
 * safe on either side of the client/server split, though in practice the
 * client only ever displays numbers the server derived.
 */
import { gatewayCostUsdc } from "@/lib/billing";

/** Rough chars-per-token for English prose + markup fragments. */
export const CHARS_PER_TOKEN = 4;

/**
 * Fixed allowance per call on top of the system prompt: the caller's payload,
 * message framing, and the response. Calibrated against a live run — a
 * 26,959-char system prompt billed 8,045 tokens; 26_959/4 + 1_200 = 7_940.
 */
export const CALL_OVERHEAD_TOKENS = 1_200;

/** Margin over metered cost baked into the derived default price. */
export const SITE_AGENT_PRICE_MARGIN = 0.5;

export interface SiteAgentPricing {
  /** Estimated tokens one call moves through the gateway. */
  readonly estimatedTokens: number;
  /** Estimated metered cost of one call, un-rounded. */
  readonly estimatedCostUsdc: number;
  /** Hard minimum price: the metered cost, rounded up to the cent. */
  readonly floorUsdc: number;
  /** Suggested price: cost plus margin, never below the blueprint minimum. */
  readonly suggestedUsdc: number;
}

function roundUpToCent(value: number): number {
  return Math.ceil(value * 100 - 1e-9) / 100;
}

export function estimateCallTokens(systemPromptChars: number): number {
  return Math.ceil(Math.max(0, systemPromptChars) / CHARS_PER_TOKEN) + CALL_OVERHEAD_TOKENS;
}

/** Everything the pricing decision rests on, for one drafted prompt. */
export function deriveSiteAgentPricing(
  systemPromptChars: number,
  blueprintMinimumUsdc: number,
): SiteAgentPricing {
  const estimatedTokens = estimateCallTokens(systemPromptChars);
  const estimatedCostUsdc = gatewayCostUsdc(estimatedTokens);
  const floorUsdc = roundUpToCent(estimatedCostUsdc);
  const suggestedUsdc = Math.max(
    roundUpToCent(estimatedCostUsdc * (1 + SITE_AGENT_PRICE_MARGIN)),
    blueprintMinimumUsdc,
    floorUsdc,
  );
  return { estimatedTokens, estimatedCostUsdc, floorUsdc, suggestedUsdc };
}

/**
 * Resolve the launch price: the caller's ask, but never below the cost
 * floor. A caller who asks for nothing (or less than cost) gets the floor —
 * "free" is not available for an agent that costs real model time per call.
 */
export function resolveSiteAgentPriceUsdc(
  requestedUsdc: number | undefined,
  pricing: SiteAgentPricing,
): number {
  if (requestedUsdc === undefined) return pricing.suggestedUsdc;
  return Math.max(requestedUsdc, pricing.floorUsdc);
}
