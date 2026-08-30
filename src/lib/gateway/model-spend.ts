/**
 * Entitlement + metering for model spend that happens OUTSIDE the
 * `/api/gateway/*` routes.
 *
 * Several features want a model call as part of doing something else — the
 * site-agent profile refinement, the Guided interview — and each one reached
 * for `process.env.ANTHROPIC_API_KEY` directly. That path had no quota, no
 * per-IP budget, no usage ledger and no entitlement: only BotID and a
 * per-owner rate limit that a freshly-minted workspace UUID resets. It is the
 * same funded-key hole the gateway-abuse pass closed for /api/gateway/llm
 * (commit abcc560), reopened once per feature that forgot about it.
 *
 * This is the shared answer. Ask `modelSpendEntitlement` before calling a
 * model, and `recordModelSpend` after. Both use the gateway's own rules and
 * its own `usage` ledger (kind `"llm"`), so spend from anywhere counts
 * against the same monthly allowance and the same shared per-IP budget.
 *
 * The entitlement is the platform rule: **a workspace that has paid at least
 * once** (see gateway/eligibility.ts). Features are expected to degrade
 * rather than fail — the site agent falls back to its deterministic profile,
 * Guided falls back to its deterministic interview — so an unpaid visitor
 * still gets working software, just not free model time.
 *
 * Server-only.
 */
import {
  FREE_MONTHLY_GATEWAY_TOKENS,
  gatewayCostUsdc,
  IP_DAILY_GATEWAY_TOKEN_BUDGET,
} from "@/lib/billing";
import type { FlowRepo } from "@/lib/db/repo";
import { freeAllowanceEligible } from "@/lib/gateway/eligibility";
import { chargeTokenBudget, peekTokenBudget } from "@/lib/rate-limit";

/** Usage ledger kind — deliberately the gateway's own, so every feature's
 * model spend lands in one place and counts against one allowance. */
export const MODEL_SPEND_USAGE_KIND = "llm";

export interface ModelSpendBilling {
  readonly ownerId: string;
  readonly repo: FlowRepo;
  /** Caller IP, when known, for the shared daily free-token budget. */
  readonly ip?: string | null;
}

export type ModelSpendDenialReason =
  /** Workspace has never paid, and holds no credit. */
  | "unpaid"
  /** Paid workspace, but the month's allowance is spent and credit is empty. */
  | "allowance-spent"
  /** This network's shared daily free-token budget is exhausted. */
  | "network-budget";

export type ModelSpendEntitlement =
  | { readonly allowed: true; readonly spendingCredit: boolean; readonly ipBudgetKey: string | null }
  | { readonly allowed: false; readonly reason: ModelSpendDenialReason };

/**
 * May this workspace spend model time right now?
 *
 * Mirrors the gateway's ordering: free allowance (earned by having paid) →
 * live credit → shared per-IP daily budget. Fails CLOSED on every read error,
 * because the thing being protected is a funded API key.
 */
export async function modelSpendEntitlement(
  billing: ModelSpendBilling,
  nowMs: number = Date.now(),
): Promise<ModelSpendEntitlement> {
  const { ownerId, repo } = billing;
  const balance = async (): Promise<number> => repo.getCreditBalance(ownerId).catch(() => 0);

  let spendingCredit = false;
  const monthlyUnits = await repo
    .sumMonthlyUsage(ownerId, MODEL_SPEND_USAGE_KIND)
    .catch(() => Number.POSITIVE_INFINITY);

  if (monthlyUnits >= FREE_MONTHLY_GATEWAY_TOKENS) {
    if ((await balance()) <= 0) return { allowed: false, reason: "allowance-spent" };
    spendingCredit = true;
  } else if (!(await freeAllowanceEligible(ownerId, repo, nowMs))) {
    // Never paid. Live credit still counts as having paid.
    if ((await balance()) <= 0) return { allowed: false, reason: "unpaid" };
    spendingCredit = true;
  }

  // Only free usage is charged against the network's daily budget; paid
  // credit is real money and exempt.
  const ipBudgetKey =
    billing.ip && !spendingCredit ? `gateway-ip-tokens:${billing.ip}` : null;
  if (ipBudgetKey) {
    const peek = peekTokenBudget(ipBudgetKey, { capacity: IP_DAILY_GATEWAY_TOKEN_BUDGET }, nowMs);
    if (peek.remaining < 1) {
      if ((await balance()) <= 0) return { allowed: false, reason: "network-budget" };
      return { allowed: true, spendingCredit: true, ipBudgetKey: null };
    }
  }

  return { allowed: true, spendingCredit, ipBudgetKey };
}

/**
 * Book completed model spend: usage row, credit debit when past the free
 * allowance, and the shared IP budget. Best-effort — the caller's work has
 * already succeeded, and a ledger race must not fail it.
 *
 * `reason` labels the credit debit so the ledger stays readable per feature
 * (`site-agent:refine`, `guided:draft`, …), matching the gateway's own
 * `gateway:llm`.
 */
export async function recordModelSpend(
  billing: ModelSpendBilling,
  entitlement: Extract<ModelSpendEntitlement, { allowed: true }>,
  tokens: number,
  reason: string,
  nowMs: number = Date.now(),
): Promise<void> {
  if (tokens <= 0) return;
  const costUsdc = gatewayCostUsdc(tokens);

  await billing.repo
    .createUsage({
      ownerId: billing.ownerId,
      kind: MODEL_SPEND_USAGE_KIND,
      units: tokens,
      costUsdc,
    })
    .catch(() => undefined);

  if (entitlement.spendingCredit && costUsdc > 0) {
    await billing.repo
      .createCredit({
        ownerId: billing.ownerId,
        deltaUsdc: -costUsdc,
        reason,
        tx: null,
      })
      .catch(() => undefined);
  }

  if (entitlement.ipBudgetKey) {
    chargeTokenBudget(
      entitlement.ipBudgetKey,
      tokens,
      { capacity: IP_DAILY_GATEWAY_TOKEN_BUDGET },
      nowMs,
    );
  }
}
