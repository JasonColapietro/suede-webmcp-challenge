/**
 * Tests for the gateway free-allowance eligibility gate
 * (src/lib/gateway/eligibility.ts).
 *
 * The free gateway tier runs against a real funded model key, so it is an
 * entitlement earned by having PAID, not a default. Rule change 2026-07-26:
 * launching an agent or aging past 24h no longer earns it — only money does.
 * Money is also the one signal a self-minted workspace UUID cannot fake, so
 * this subsumes the old anti-farming rule rather than weakening it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { freeAllowanceEligible, _resetEligibilityCache } from "@/lib/gateway/eligibility";
import type { FlowRepo } from "@/lib/db/repo";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function seedAgent(
  repo: SqliteRepo,
  ownerId: string,
  status: "draft" | "live",
): Promise<void> {
  const flow = await repo.saveFlow({
    ownerId,
    name: "f",
    graph: { id: `g-${ownerId}-${rand()}`, name: "f", nodes: [], edges: [] },
  });
  await repo.createAgent({ flowId: flow.id, slug: `s-${rand()}`, status, priceUsdc: 0 });
}

describe("freeAllowanceEligible", () => {
  beforeEach(() => _resetEligibilityCache());

  it("is false for a fresh workspace that has never paid", async () => {
    const repo = makeRepo();
    expect(await freeAllowanceEligible(`fresh-${rand()}`, repo, Date.now())).toBe(false);
  });

  it("is true once the workspace has been credited", async () => {
    const repo = makeRepo();
    const owner = `paid-${rand()}`;
    await repo.createCredit({ ownerId: owner, deltaUsdc: 1, reason: "topup", tx: "0xabc" });
    expect(await freeAllowanceEligible(owner, repo, Date.now())).toBe(true);
  });

  it("stays true after the credit is spent back to zero — the signal is lifetime", async () => {
    const repo = makeRepo();
    const owner = `spent-${rand()}`;
    await repo.createCredit({ ownerId: owner, deltaUsdc: 1, reason: "topup", tx: "0xabc" });
    await repo.createCredit({ ownerId: owner, deltaUsdc: -1, reason: "gateway:llm", tx: null });

    expect(await repo.getCreditBalance(owner)).toBeCloseTo(0, 6);
    expect(await freeAllowanceEligible(owner, repo, Date.now())).toBe(true);
  });

  it("is NOT earned by launching a live agent — that was the old rule", async () => {
    const repo = makeRepo();
    const owner = `live-${rand()}`;
    await seedAgent(repo, owner, "live");
    expect(await freeAllowanceEligible(owner, repo, Date.now())).toBe(false);
  });

  it("is NOT earned by workspace age — that was the old rule", async () => {
    const repo = makeRepo();
    const owner = `old-${rand()}`;
    await seedAgent(repo, owner, "draft");
    const wellPastTheOldThreshold = Date.now() + 90 * 24 * 60 * 60 * 1000;
    expect(await freeAllowanceEligible(owner, repo, wellPastTheOldThreshold)).toBe(false);
  });

  it("fails CLOSED when the credits read throws — a DB hiccup must not hand out the funded key", async () => {
    const repo = {
      hasEverPaid: async () => {
        throw new Error("db down");
      },
    } as unknown as FlowRepo;
    expect(await freeAllowanceEligible("any", repo, Date.now())).toBe(false);
  });

  it("fails CLOSED on an adapter with no payment support at all", async () => {
    expect(await freeAllowanceEligible("any", {} as unknown as FlowRepo, Date.now())).toBe(false);
  });

  it("reflects a new topup on the next call", async () => {
    const repo = makeRepo();
    const owner = `upgrade-${rand()}`;

    expect(await freeAllowanceEligible(owner, repo, Date.now())).toBe(false);
    await repo.createCredit({ ownerId: owner, deltaUsdc: 5, reason: "topup", tx: "0xdef" });
    expect(await freeAllowanceEligible(owner, repo, Date.now())).toBe(true);
  });

  it("revokes Stripe eligibility immediately after a signed full refund", async () => {
    const repo = makeRepo();
    const owner = `refunded-${rand()}`;
    const eventTime = new Date(
      Math.floor(Date.now() / 1_000) * 1_000 - 5_000,
    ).toISOString();

    await repo.recordStripeRevenueEvent({
      kind: "payment",
      providerEventId: "evt_eligibilityPayment0001",
      ownerId: owner,
      providerCheckoutSessionId: "cs_eligibilityPayment0001",
      providerPaymentIntentId: "pi_eligibilityPayment0001",
      amountTotalCents: 500,
      currency: "USD",
      terminalStatus: "paid",
      providerProductId: "prod_eligibilityPayment0001",
      providerPriceId: "price_eligibilityPayment0001",
      creditGrantUsdc: 5.5,
      occurredAt: eventTime,
    });
    expect(await freeAllowanceEligible(owner, repo, Date.now())).toBe(true);

    await repo.recordStripeRevenueEvent({
      kind: "refund",
      providerEventId: "evt_eligibilityRefund0001",
      providerPaymentIntentId: "pi_eligibilityPayment0001",
      providerRefundId: "re_eligibilityRefund0001",
      amountTotalCents: 500,
      currency: "USD",
      terminalStatus: "succeeded",
      occurredAt: new Date(Date.parse(eventTime) + 1_000).toISOString(),
    });

    expect(await repo.getCreditBalance(owner)).toBe(0);
    expect(await freeAllowanceEligible(owner, repo, Date.now())).toBe(false);
  });
});
