/**
 * The site-agent model refinement spends the funded model key, so it is
 * gated on the workspace having paid and booked to the same usage ledger as
 * the metered gateway. Before this, the draft path called Anthropic directly
 * with no quota, no per-IP budget, no ledger and no entitlement — the same
 * funded-key hole the gateway-abuse pass closed for /api/gateway/llm.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { FREE_MONTHLY_GATEWAY_TOKENS, gatewayCostUsdc } from "@/lib/billing";
import { _resetEligibilityCache } from "@/lib/gateway/eligibility";
import {
  recordModelSpend,
  modelSpendEntitlement,
  MODEL_SPEND_USAGE_KIND,
} from "@/lib/gateway/model-spend";
import type { FlowRepo } from "@/lib/db/repo";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function pay(repo: SqliteRepo, ownerId: string, usdc = 5): Promise<void> {
  await repo.createCredit({ ownerId, deltaUsdc: usdc, reason: "topup", tx: `0x${rand()}` });
}

describe("modelSpendEntitlement", () => {
  beforeEach(() => _resetEligibilityCache());

  it("denies a workspace that has never paid", async () => {
    const repo = makeRepo();
    const result = await modelSpendEntitlement({ ownerId: `free-${rand()}`, repo });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("unpaid");
  });

  it("allows a paid workspace on its included monthly allowance", async () => {
    const repo = makeRepo();
    const owner = `paid-${rand()}`;
    await pay(repo, owner);

    const result = await modelSpendEntitlement({ ownerId: owner, repo });

    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.spendingCredit).toBe(false);
  });

  it("spends credit once the monthly allowance is used up", async () => {
    const repo = makeRepo();
    const owner = `over-${rand()}`;
    await pay(repo, owner);
    await repo.createUsage({
      ownerId: owner,
      kind: MODEL_SPEND_USAGE_KIND,
      units: FREE_MONTHLY_GATEWAY_TOKENS,
      costUsdc: 0,
    });

    const result = await modelSpendEntitlement({ ownerId: owner, repo });

    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.spendingCredit).toBe(true);
  });

  it("denies when the allowance is spent and no credit remains", async () => {
    const repo = makeRepo();
    const owner = `broke-${rand()}`;
    await pay(repo, owner, 1);
    await repo.createCredit({ ownerId: owner, deltaUsdc: -1, reason: "gateway:llm", tx: null });
    await repo.createUsage({
      ownerId: owner,
      kind: MODEL_SPEND_USAGE_KIND,
      units: FREE_MONTHLY_GATEWAY_TOKENS,
      costUsdc: 0,
    });

    const result = await modelSpendEntitlement({ ownerId: owner, repo });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("allowance-spent");
  });

  it("fails closed when the usage ledger is unreadable", async () => {
    const repo = {
      sumMonthlyUsage: async () => {
        throw new Error("billing not provisioned");
      },
      getCreditBalance: async () => 0,
    } as unknown as FlowRepo;

    const result = await modelSpendEntitlement({ ownerId: "any", repo });
    expect(result.allowed).toBe(false);
  });

  it("charges free usage against the network budget, paid usage never", async () => {
    const repo = makeRepo();
    const free = `ipfree-${rand()}`;
    const paid = `ippaid-${rand()}`;
    await pay(repo, free);
    await pay(repo, paid, 5);
    await repo.createUsage({
      ownerId: paid,
      kind: MODEL_SPEND_USAGE_KIND,
      units: FREE_MONTHLY_GATEWAY_TOKENS,
      costUsdc: 0,
    });

    const onAllowance = await modelSpendEntitlement({ ownerId: free, repo, ip: "203.0.113.9" });
    const onCredit = await modelSpendEntitlement({ ownerId: paid, repo, ip: "203.0.113.9" });

    expect(onAllowance.allowed && onAllowance.ipBudgetKey).toBeTruthy();
    expect(onCredit.allowed && onCredit.ipBudgetKey).toBeNull();
  });
});

describe("recordModelSpend", () => {
  beforeEach(() => _resetEligibilityCache());

  it("books the tokens to the gateway's own ledger so they count against the allowance", async () => {
    const repo = makeRepo();
    const owner = `ledger-${rand()}`;
    await pay(repo, owner);
    const entitlement = await modelSpendEntitlement({ ownerId: owner, repo });
    if (!entitlement.allowed) throw new Error("expected an allowed entitlement");

    await recordModelSpend({ ownerId: owner, repo }, entitlement, 8_045, "site-agent:refine");

    expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(8_045);
  });

  it("debits credit only when past the allowance", async () => {
    const repo = makeRepo();
    const owner = `debit-${rand()}`;
    await pay(repo, owner, 5);
    await repo.createUsage({
      ownerId: owner,
      kind: MODEL_SPEND_USAGE_KIND,
      units: FREE_MONTHLY_GATEWAY_TOKENS,
      costUsdc: 0,
    });
    const entitlement = await modelSpendEntitlement({ ownerId: owner, repo });
    if (!entitlement.allowed) throw new Error("expected an allowed entitlement");
    expect(entitlement.spendingCredit).toBe(true);

    await recordModelSpend({ ownerId: owner, repo }, entitlement, 8_045, "site-agent:refine");

    expect(await repo.getCreditBalance(owner)).toBeCloseTo(5 - gatewayCostUsdc(8_045), 6);
  });

  it("writes nothing for a zero-token result", async () => {
    const repo = makeRepo();
    const owner = `zero-${rand()}`;
    await pay(repo, owner);
    const entitlement = await modelSpendEntitlement({ ownerId: owner, repo });
    if (!entitlement.allowed) throw new Error("expected an allowed entitlement");

    await recordModelSpend({ ownerId: owner, repo }, entitlement, 0, "site-agent:refine");

    expect(await repo.sumMonthlyUsage(owner, MODEL_SPEND_USAGE_KIND)).toBe(0);
  });
});
