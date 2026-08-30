/**
 * Gateway topup handler — x402-paid USDC credit topup.
 *
 * Accepts ?tier=1|5|20 (USDC amounts).
 * payTo is ALWAYS the Suede seller wallet (never creator wallets).
 * On successful settle: writes a credits row for the owner.
 *
 * Server-only.
 */
import { z } from "zod";
import { verifyAndSettle } from "@/lib/rails/x402-verify";
import { USDC_BASE_ASSET } from "@/lib/payout";
import type { FlowRepo } from "@/lib/db/repo";

// ---------------------------------------------------------------------------
// Tier schema
// ---------------------------------------------------------------------------

/** Accepted topup tiers in USDC. */
export const TOPUP_TIERS = [1, 5, 20] as const;
export type TopupTier = (typeof TOPUP_TIERS)[number];

export const TopupTierSchema = z
  .union([z.literal(1), z.literal(5), z.literal(20)])
  .default(1);

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type TopupChallengeResult = {
  ok: false;
  status: 402;
  x402Version: 1;
  error: string;
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    resource: string;
    payTo: string;
    asset: string;
    description: string;
  }>;
};

export type TopupSuccessResult = {
  ok: true;
  creditsAdded: number;
  transaction: string | null;
  payer: string | null;
};

export type TopupErrorResult = {
  ok: false;
  status: 400 | 401 | 500 | 503;
  error: string;
};

export type TopupResult = TopupChallengeResult | TopupSuccessResult | TopupErrorResult;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const SITE_ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://agents.suedeai.ai").replace(
  /\/+$/,
  "",
);

/**
 * Process a gateway topup request.
 *
 * @param ownerId        - Resolved workspace owner (already authenticated).
 * @param tier           - USDC topup tier (1 | 5 | 20).
 * @param paymentHeader  - Raw x-payment header value (null = not provided → issue 402 challenge).
 * @param repo           - FlowRepo for credits write.
 */
export async function handleGatewayTopup(
  ownerId: string,
  tier: TopupTier,
  paymentHeader: string | null,
  repo: FlowRepo,
): Promise<TopupResult> {
  const sellerWallet = process.env.X402_SELLER_WALLET_ADDRESS;
  if (!sellerWallet) {
    return { ok: false, status: 503, error: "topup not available: seller wallet not configured" };
  }

  // Provisioning probe BEFORE any 402 challenge: never invite a real USDC
  // payment that would settle and then fail to credit because the credits
  // table doesn't exist yet. Unprovisioned billing = 503, full stop.
  try {
    await repo.getCreditBalance(ownerId);
  } catch {
    return { ok: false, status: 503, error: "billing not provisioned" };
  }

  const resource = `/api/gateway/topup?tier=${tier}`;

  const challenge = (): TopupChallengeResult => ({
    ok: false,
    status: 402,
    x402Version: 1,
    error: "payment required",
    accepts: [
      {
        scheme: "exact",
        network: "base-mainnet",
        maxAmountRequired: String(tier),
        resource,
        payTo: sellerWallet,
        asset: USDC_BASE_ASSET,
        description: `Suede gateway credit — $${tier} USDC`,
      },
    ],
  });

  if (!paymentHeader) {
    return challenge();
  }

  let settlement: Awaited<ReturnType<typeof verifyAndSettle>>;
  try {
    settlement = await verifyAndSettle({
      paymentHeader,
      payTo: sellerWallet,
      amountUsdc: tier,
      resource,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "settlement error";
    return { ok: false, status: 500, error: message };
  }

  if (!settlement.ok) {
    return challenge();
  }

  // Write credit row.
  try {
    await repo.createCredit({
      ownerId,
      deltaUsdc: tier,
      reason: "topup",
      tx: settlement.transaction ?? null,
    });
  } catch (err: unknown) {
    // Credits table absent — billing not provisioned. Return 503.
    const message = err instanceof Error ? err.message : "credit write failed";
    return { ok: false, status: 503, error: `billing not provisioned: ${message}` };
  }

  return {
    ok: true,
    creditsAdded: tier,
    transaction: settlement.transaction,
    payer: settlement.payer,
  };
}

/**
 * Machine-readable topup instructions for 402 responses from metered routes.
 * Embed in gateway 402 responses so SDK clients can surface the topup URL.
 * Names both funding rails: the x402/USDC endpoint a machine can pay
 * directly, and the Stripe card checkout for workspaces without a wallet.
 */
export function topupInstructions(): {
  topupEndpoint: string;
  cardCheckoutEndpoint: string;
  tiers: readonly number[];
  message: string;
} {
  return {
    topupEndpoint: `${SITE_ORIGIN}/api/gateway/topup`,
    cardCheckoutEndpoint: `${SITE_ORIGIN}/api/gateway/topup/stripe`,
    tiers: TOPUP_TIERS,
    message:
      `Top up gateway credit at ${SITE_ORIGIN}/api/gateway/topup?tier=1 (USDC on Base, x402), ` +
      `or pay by card via POST ${SITE_ORIGIN}/api/gateway/topup/stripe.`,
  };
}
