/**
 * Free-allowance eligibility for the metered gateway.
 *
 * The free tier runs against a real, funded model key, so it is an
 * entitlement, not a default. **A workspace earns it by having paid.**
 *
 * "Paid" means retained payment evidence: an irreversible positive grant, or
 * positive Stripe topup value after Stripe refund reversals. Spending paid
 * credit back to zero does not revoke the entitlement, but a full provider
 * refund does. This is payment provenance, not a second wallet.
 *
 * Rule change 2026-07-26 (Jason). Previously a workspace earned the
 * allowance by having "skin in the game" — a launched agent, or a workspace
 * older than 24h. That gated UUID-farming (the abuse case it was written
 * for) but it still gave real model spend to people who had never paid
 * anything, which is not the commercial model. Now:
 *
 *   eligible ⟺ the workspace retains non-refunded payment evidence
 *
 * Workspace keys are self-minted UUIDs (see /api/me/claim + middleware), and
 * money is the one signal a fresh UUID cannot fake, so this subsumes the old
 * anti-farming rule rather than weakening it.
 *
 * FAILS CLOSED. A read error returns false, unlike the previous rule which
 * failed open. Denial is recoverable and honest (callers answer 402 with
 * topup instructions), whereas failing open hands the funded key to anyone
 * who can trigger a database hiccup. Callers check paid credit separately
 * immediately afterwards, so a genuine customer with balance is unaffected
 * by a false negative here.
 */
import type { FlowRepo } from "@/lib/db/repo";

/**
 * Is `ownerId` entitled to the FREE gateway allowance?
 *
 * This is intentionally uncached: a signed full refund makes a previously
 * eligible workspace ineligible, so a positive-only lifetime cache would hand
 * the funded model key to a fully refunded workspace.
 */
export async function freeAllowanceEligible(
  ownerId: string,
  repo: FlowRepo,
  _nowMs: number = Date.now(),
): Promise<boolean> {
  // No adapter support (or a driver error) means we cannot prove payment.
  // Unproven is unpaid.
  if (!repo.hasEverPaid) return false;

  let paid: boolean;
  try {
    paid = await repo.hasEverPaid(ownerId);
  } catch {
    return false;
  }

  return paid;
}

/** Backward-compatible test hook; eligibility no longer has a positive cache. */
export function _resetEligibilityCache(): void {
  // Intentionally empty.
}
