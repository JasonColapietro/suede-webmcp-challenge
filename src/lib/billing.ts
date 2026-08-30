/**
 * Platform billing constants and pure split/cost functions.
 *
 * All rate constants live HERE — nothing in copy or route handlers should
 * hardcode a number. Import from here and derive display strings at callsites.
 *
 * Server-safe (no DOM, no Next imports) — can be imported from both client
 * components (via node-meta pattern) and server routes.
 */

/** Platform take rate on every settled x402 call to a user agent. */
export const PLATFORM_TAKE_RATE = 0; // 0% — full settled price routes to the creator

/** Markup on raw LLM cost for tokens consumed through the gateway. */
export const GATEWAY_MARGIN = 0.2; // 20% on top of cost

/**
 * Reduced gateway margin applied to committed-use bulk credit purchases.
 * The gap between this and the pay-as-you-go GATEWAY_MARGIN IS the commitment
 * discount — carved from the existing gateway margin (real, already-collected
 * money on the spend side), never from the creator's earn side. Nothing on the
 * hot metering/debit path uses this; it only sizes the bonus credit granted at
 * purchase time (see commitGrantUsdc).
 *
 * PLACEHOLDER VALUE pending a business decision. Set to half the current
 * pay-as-you-go GATEWAY_MARGIN (0.20 → 0.10). If GATEWAY_MARGIN moves, revisit
 * this so the discount stays an intentional call, not an incidental one.
 */
export const COMMIT_GATEWAY_MARGIN = 0.1; // 10% — half of GATEWAY_MARGIN (placeholder)

/**
 * Committed-use dollar tiers offered as one-charge bulk credit purchases.
 * PLACEHOLDER VALUES pending a business decision on the tier ladder.
 */
export const COMMIT_TIERS = [50, 100, 250] as const;
export type CommitTier = (typeof COMMIT_TIERS)[number];

/**
 * Free monthly gateway tokens per workspace before the 402 gate kicks in.
 * At ~750 tokens per "average" LLM call, this is ~133 gateway calls/month free.
 */
export const FREE_MONTHLY_GATEWAY_TOKENS = 100_000;

/**
 * Hard ceiling on FREE gateway tokens consumable from a single source IP per
 * day, summed across every workspace key seen from that IP.
 *
 * Workspace keys are self-minted UUIDs, so the per-workspace monthly cap alone
 * does nothing against an attacker minting a fresh key per 100k tokens. This
 * per-IP/day budget bounds the damage regardless of how many keys one IP cycles
 * through. Paid (credit) usage is NOT counted against it. Intentionally generous
 * (2× the per-workspace monthly free tier) so shared/NAT'd networks aren't hurt;
 * easy to tune Jason-side.
 */
export const IP_DAILY_GATEWAY_TOKEN_BUDGET = 200_000;

/**
 * Approximate platform USDC cost per token through the gateway.
 * Based on Sonnet 4.6 blended input/output rate ($3/$15 per 1M) at the
 * default model, marked up by GATEWAY_MARGIN.
 *
 * $9/1M tokens blended → $0.000009/token, +20% = ~$0.0000108/token.
 * This constant is intentionally conservative (easy to tune Jason-side).
 */
const BASE_COST_PER_TOKEN_USDC = 0.000009;

/**
 * Per-1M-token gateway price at a given margin. The single source the
 * pricing and docs pages import — previously each hand-copied the $9
 * blended base, which the header rule above exists to prevent.
 */
export function gatewayPricePer1M(margin: number): number {
  const basePer1M = BASE_COST_PER_TOKEN_USDC * 1_000_000;
  return Math.round(basePer1M * (1 + margin) * 100) / 100;
}

/**
 * Named LLM model tiers surfaced in the flow builder's model picker, so
 * builders can weigh speed/cost against quality before wiring an LLM node.
 *
 * `blendedPer1MUsdc` is each model's published list price, averaged across
 * input/output — the same blending method used for BASE_COST_PER_TOKEN_USDC
 * above (Sonnet's $3/$15 per 1M -> $9/1M blended, matching that constant
 * exactly). Haiku's list price is $1/$5 per 1M -> $3/1M blended; Opus's is
 * $15/$75 per 1M -> $45/1M blended. These are list prices for comparing
 * tiers, not the gateway's GATEWAY_MARGIN-marked-up billed rate.
 */
export interface LlmModelTier {
  readonly modelId: string;
  readonly label: string;
  readonly blendedPer1MUsdc: number;
}

export const LLM_MODEL_TIERS: readonly LlmModelTier[] = [
  {
    modelId: "claude-haiku-4-5-20251001",
    label: "Fast & cheap",
    blendedPer1MUsdc: 3,
  },
  {
    modelId: "claude-sonnet-4-6",
    label: "Balanced (recommended)",
    blendedPer1MUsdc: 9,
  },
  {
    modelId: "claude-opus-4-6",
    label: "Best quality",
    blendedPer1MUsdc: 45,
  },
];

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export interface CallSplit {
  /** USDC amount that routes to the creator. */
  creatorUsdc: number;
  /** USDC amount retained by the platform. */
  platformUsdc: number;
}

/**
 * Split a settled call payment between creator and platform.
 *
 * @param priceUsdc - The agent's declared price in USDC (e.g. 0.25).
 * @returns Split amounts. Rounds to 6 decimal places (USDC precision).
 */
export function splitCall(priceUsdc: number): CallSplit {
  const platformUsdc = round6(priceUsdc * PLATFORM_TAKE_RATE);
  const creatorUsdc = round6(priceUsdc - platformUsdc);
  return { creatorUsdc, platformUsdc };
}

/**
 * Calculate the gateway cost in USDC for a given token count.
 *
 * @param tokens - Total tokens consumed (input + output combined).
 * @returns Cost in USDC.
 */
export function gatewayCostUsdc(tokens: number): number {
  return round6(tokens * BASE_COST_PER_TOKEN_USDC * (1 + GATEWAY_MARGIN));
}

/**
 * Credit granted for a committed-use bulk purchase of `chargeUsdc` dollars.
 *
 * The bonus multiplier is derived purely from the two margin constants —
 * (1 + GATEWAY_MARGIN) / (1 + COMMIT_GATEWAY_MARGIN) — so it can never drift
 * from them: the buyer pre-buys tokens at the committed margin instead of the
 * pay-as-you-go margin, and the extra credit is exactly that margin gap. The
 * hot metering/debit path is untouched; the discount is delivered as bonus
 * credit at purchase time. While COMMIT_GATEWAY_MARGIN < GATEWAY_MARGIN the
 * result is always >= chargeUsdc.
 *
 * @param chargeUsdc - The dollar amount actually charged.
 * @returns Credit to grant, in USDC, rounded to 6 decimals.
 */
export function commitGrantUsdc(chargeUsdc: number): number {
  return round6(chargeUsdc * ((1 + GATEWAY_MARGIN) / (1 + COMMIT_GATEWAY_MARGIN)));
}

/** Round to 6 decimal places (USDC precision). */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Query the credit balance for an owner from the credits ledger.
 * Returns 0 when the table does not yet exist (dark-deploy safe).
 *
 * @param ownerId - The workspace owner id.
 * @param repo    - FlowRepo implementation.
 * @returns Sum of all credits deltas (can be negative if debits were recorded).
 */
export async function creditBalance(
  ownerId: string,
  repo: { getCreditBalance: (ownerId: string) => Promise<number> },
): Promise<number> {
  return repo.getCreditBalance(ownerId);
}
