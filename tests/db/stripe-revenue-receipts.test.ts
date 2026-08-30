import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import type { StripeTopupPaymentRevenueInput } from "@/lib/db/repo";

function database(repo: SqliteRepo): Database.Database {
  return (repo as unknown as { db: Database.Database }).db;
}

const occurredBaseMs = Math.floor(Date.now() / 1_000) * 1_000 - 10_000;

function occurredAt(offsetMs = 0): string {
  return new Date(occurredBaseMs + offsetMs).toISOString();
}

function paymentInput(
  overrides: Partial<StripeTopupPaymentRevenueInput> = {},
): StripeTopupPaymentRevenueInput {
  return {
    kind: "payment" as const,
    providerEventId: "evt_paymentReceipt0001",
    ownerId: "owner-private-1",
    providerCheckoutSessionId: "cs_paymentReceipt0001",
    providerPaymentIntentId: "pi_paymentReceipt0001",
    amountTotalCents: 500,
    currency: "USD",
    terminalStatus: "paid" as const,
    providerProductId: "prod_gatewayCredit0001",
    providerPriceId: "price_gatewayCredit0001",
    creditGrantUsdc: 5,
    occurredAt: occurredAt(),
    ...overrides,
  };
}

describe("SQLite private Stripe revenue receipts", () => {
  it("atomically records provider cash separately from granted credit", async () => {
    const repo = new SqliteRepo(":memory:");
    const result = await repo.recordStripeRevenueEvent(
      paymentInput({ amountTotalCents: 5_000, creditGrantUsdc: 54.54545455 }),
    );

    expect(result).toEqual({
      recorded: true,
      creditDeltaUsdc: 54.54545455,
      refundState: "none",
    });
    const receipt = database(repo).prepare(
      `SELECT amount_total_cents, currency, credit_delta_usdc,
              terminal_status, refund_state
       FROM stripe_revenue_receipts`,
    ).get();
    expect(receipt).toEqual({
      amount_total_cents: 5_000,
      currency: "USD",
      credit_delta_usdc: 54.54545455,
      terminal_status: "paid",
      refund_state: "none",
    });
  });

  it("keeps raw provider ids private and uses only an internal credit reference", async () => {
    const repo = new SqliteRepo(":memory:");
    await repo.recordStripeRevenueEvent(paymentInput());
    const db = database(repo);

    const privateReceipt = db.prepare(
      `SELECT provider_event_id, provider_checkout_session_id,
              provider_payment_intent_id, provider_product_id, provider_price_id
       FROM stripe_revenue_receipts`,
    ).get();
    expect(privateReceipt).toEqual({
      provider_event_id: "evt_paymentReceipt0001",
      provider_checkout_session_id: "cs_paymentReceipt0001",
      provider_payment_intent_id: "pi_paymentReceipt0001",
      provider_product_id: "prod_gatewayCredit0001",
      provider_price_id: "price_gatewayCredit0001",
    });
    const credit = db.prepare("SELECT tx FROM credits").get() as { tx: string };
    expect(credit.tx).toMatch(/^stripe-receipt:[0-9a-f-]{36}$/u);
    expect(credit.tx).not.toMatch(/(?:evt|cs|pi|prod|price)_/u);
  });

  it("is idempotent and refuses conflicting replays", async () => {
    const repo = new SqliteRepo(":memory:");
    const input = paymentInput();
    await expect(repo.recordStripeRevenueEvent(input)).resolves.toMatchObject({
      recorded: true,
    });
    await expect(repo.recordStripeRevenueEvent(input)).resolves.toMatchObject({
      recorded: false,
    });
    await expect(repo.recordStripeRevenueEvent({
      ...input,
      providerEventId: "evt_paymentReceipt0002",
      occurredAt: occurredAt(1_000),
    })).resolves.toMatchObject({
      recorded: false,
    });
    await expect(
      repo.recordStripeRevenueEvent({ ...input, amountTotalCents: 600 }),
    ).rejects.toThrow("receipt conflict");

    expect(database(repo).prepare("SELECT count(*) AS n FROM credits").get())
      .toEqual({ n: 1 });
    expect(
      database(repo)
        .prepare("SELECT count(*) AS n FROM stripe_revenue_receipts")
        .get(),
    ).toEqual({ n: 1 });
  });

  it("records partial/full refunds as negative cash facts and reverses bonus credit proportionally", async () => {
    const repo = new SqliteRepo(":memory:");
    await repo.recordStripeRevenueEvent(
      paymentInput({ amountTotalCents: 500, creditGrantUsdc: 5.5 }),
    );

    const first = await repo.recordStripeRevenueEvent({
      kind: "refund",
      providerEventId: "evt_refundReceipt0001",
      providerPaymentIntentId: "pi_paymentReceipt0001",
      providerRefundId: "re_refundReceipt0001",
      amountTotalCents: 200,
      currency: "USD",
      terminalStatus: "succeeded",
      occurredAt: occurredAt(1_000),
    });
    expect(first).toEqual({
      recorded: true,
      creditDeltaUsdc: -2.2,
      refundState: "partial",
    });
    expect(await repo.hasEverPaid("owner-private-1")).toBe(true);
    await expect(repo.recordStripeRevenueEvent({
      kind: "refund",
      providerEventId: "evt_refundReceiptUpdated0001",
      providerPaymentIntentId: "pi_paymentReceipt0001",
      providerRefundId: "re_refundReceipt0001",
      amountTotalCents: 200,
      currency: "USD",
      terminalStatus: "succeeded",
      occurredAt: occurredAt(1_500),
    })).resolves.toEqual({
      recorded: false,
      creditDeltaUsdc: -2.2,
      refundState: "partial",
    });

    const second = await repo.recordStripeRevenueEvent({
      kind: "refund",
      providerEventId: "evt_refundReceipt0002",
      providerPaymentIntentId: "pi_paymentReceipt0001",
      providerRefundId: "re_refundReceipt0002",
      amountTotalCents: 300,
      currency: "USD",
      terminalStatus: "succeeded",
      occurredAt: occurredAt(2_000),
    });
    expect(second).toEqual({
      recorded: true,
      creditDeltaUsdc: -3.3,
      refundState: "full",
    });
    expect(await repo.getCreditBalance("owner-private-1")).toBe(0);
    expect(await repo.hasEverPaid("owner-private-1")).toBe(false);
    database(repo).prepare(
      `UPDATE credits
       SET reason = CASE
         WHEN delta_usdc > 0 THEN 'topup'
         ELSE 'gateway:tampered'
       END
       WHERE owner_id = 'owner-private-1'`,
    ).run();
    expect(await repo.hasEverPaid("owner-private-1")).toBe(false);

    const rows = database(repo).prepare(
      `SELECT kind, amount_total_cents, credit_delta_usdc, refund_state
       FROM stripe_revenue_receipts ORDER BY occurred_at`,
    ).all();
    expect(rows).toEqual([
      {
        kind: "payment",
        amount_total_cents: 500,
        credit_delta_usdc: 5.5,
        refund_state: "none",
      },
      {
        kind: "refund",
        amount_total_cents: 200,
        credit_delta_usdc: -2.2,
        refund_state: "partial",
      },
      {
        kind: "refund",
        amount_total_cents: 300,
        credit_delta_usdc: -3.3,
        refund_state: "full",
      },
    ]);
  });

  it("reverses an adopted payment from the current credit owner", async () => {
    const repo = new SqliteRepo(":memory:");
    await repo.recordStripeRevenueEvent(paymentInput({
      ownerId: "owner-anonymous",
    }));
    await repo.adoptOwner("owner-anonymous", "owner-account");
    await expect(repo.recordStripeRevenueEvent(paymentInput({
      ownerId: "owner-anonymous",
    }))).resolves.toMatchObject({
      recorded: false,
      creditDeltaUsdc: 5,
    });

    await expect(repo.recordStripeRevenueEvent({
      kind: "refund",
      providerEventId: "evt_adoptedRefund0001",
      providerPaymentIntentId: "pi_paymentReceipt0001",
      providerRefundId: "re_adoptedRefund0001",
      amountTotalCents: 500,
      currency: "USD",
      terminalStatus: "succeeded",
      occurredAt: occurredAt(2_500),
    })).resolves.toEqual({
      recorded: true,
      creditDeltaUsdc: -5,
      refundState: "full",
    });

    expect(await repo.getCreditBalance("owner-anonymous")).toBe(0);
    expect(await repo.getCreditBalance("owner-account")).toBe(0);
    expect(await repo.hasEverPaid("owner-anonymous")).toBe(false);
    expect(await repo.hasEverPaid("owner-account")).toBe(false);
    expect(
      database(repo)
        .prepare(
          `SELECT owner_id
           FROM credits
           ORDER BY delta_usdc DESC`,
        )
        .all(),
    ).toEqual([
      { owner_id: "owner-account" },
      { owner_id: "owner-account" },
    ]);
    expect(
      database(repo)
        .prepare(
          `SELECT count(DISTINCT owner_id) AS owners
           FROM stripe_revenue_receipts`,
        )
        .get(),
    ).toEqual({ owners: 1 });
  });

  it("routes a delayed payment webhook through a completed owner adoption", async () => {
    const repo = new SqliteRepo(":memory:");
    await repo.adoptOwner("owner-anonymous", "owner-account");

    await expect(repo.recordStripeRevenueEvent(paymentInput({
      ownerId: "owner-anonymous",
    }))).resolves.toMatchObject({
      recorded: true,
      creditDeltaUsdc: 5,
    });

    expect(await repo.getCreditBalance("owner-anonymous")).toBe(0);
    expect(await repo.getCreditBalance("owner-account")).toBe(5);
    expect(
      database(repo)
        .prepare(
          `SELECT owner_id
           FROM stripe_revenue_receipts
           WHERE kind = 'payment'`,
        )
        .get(),
    ).toEqual({ owner_id: "owner-account" });
  });

  it("routes delayed evidence through an out-of-order adoption chain", async () => {
    const repo = new SqliteRepo(":memory:");
    await repo.adoptOwner("owner-account", "owner-final");
    await repo.adoptOwner("owner-anonymous", "owner-account");

    await expect(repo.recordStripeRevenueEvent(paymentInput({
      ownerId: "owner-anonymous",
    }))).resolves.toMatchObject({
      recorded: true,
      creditDeltaUsdc: 5,
    });

    expect(await repo.getCreditBalance("owner-anonymous")).toBe(0);
    expect(await repo.getCreditBalance("owner-account")).toBe(0);
    expect(await repo.getCreditBalance("owner-final")).toBe(5);
    expect(
      database(repo)
        .prepare(
          `SELECT owner_id
           FROM stripe_revenue_receipts
           WHERE kind = 'payment'`,
        )
        .get(),
    ).toEqual({ owner_id: "owner-final" });
  });

  it("accepts a canonical-equivalent adoption retry and moves late owner rows", async () => {
    const repo = new SqliteRepo(":memory:");
    await repo.adoptOwner("owner-alias-a", "owner-alias-b");
    await repo.adoptOwner("owner-alias-b", "owner-alias-c");
    await repo.createCredit({
      ownerId: "owner-alias-a",
      deltaUsdc: 1,
      reason: "topup",
      tx: "late-canonical-retry",
    });

    await expect(
      repo.adoptOwner("owner-alias-a", "owner-alias-c"),
    ).resolves.toBeUndefined();

    expect(await repo.getCreditBalance("owner-alias-a")).toBe(0);
    expect(await repo.getCreditBalance("owner-alias-c")).toBe(1);
    expect(
      database(repo)
        .prepare(
          `SELECT to_owner_id
           FROM stripe_owner_adoptions
           WHERE from_owner_id = 'owner-alias-a'`,
        )
        .get(),
    ).toEqual({ to_owner_id: "owner-alias-b" });
  });

  it("allows 31 joined alias edges but rejects edge 32 before mutation", async () => {
    const repo = new SqliteRepo(":memory:");
    const upstream = [
      ...Array.from(
        { length: 15 },
        (_, index) => `owner-depth-up-${index}`,
      ),
      "owner-depth-join",
    ];
    const downstream = [
      ...Array.from(
        { length: 15 },
        (_, index) => `owner-depth-down-${index}`,
      ),
      "owner-depth-terminal",
    ];
    for (let index = 0; index < 15; index += 1) {
      await repo.adoptOwner(upstream[index], upstream[index + 1]);
      await repo.adoptOwner(downstream[index], downstream[index + 1]);
    }
    await repo.adoptOwner("owner-depth-join", "owner-depth-down-0");

    await expect(repo.recordStripeRevenueEvent(paymentInput({
      ownerId: "owner-depth-up-0",
    }))).resolves.toMatchObject({
      recorded: true,
      creditDeltaUsdc: 5,
    });
    await expect(
      repo.adoptOwner("owner-depth-terminal", "owner-depth-overflow"),
    ).rejects.toThrow("chain is too deep");

    expect(await repo.getCreditBalance("owner-depth-terminal")).toBe(5);
    expect(
      database(repo)
        .prepare("SELECT count(*) AS n FROM stripe_owner_adoptions")
        .get(),
    ).toEqual({ n: 31 });
    expect(
      database(repo)
        .prepare(
          `SELECT count(*) AS n
           FROM stripe_owner_adoptions
           WHERE from_owner_id = 'owner-depth-terminal'`,
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it("rolls back both receipt and credit when refund evidence is invalid", async () => {
    const repo = new SqliteRepo(":memory:");
    await repo.recordStripeRevenueEvent(paymentInput());

    await expect(
      repo.recordStripeRevenueEvent({
        kind: "refund",
        providerEventId: "evt_refundReceipt0003",
        providerPaymentIntentId: "pi_paymentReceipt0001",
        providerRefundId: "re_refundReceipt0003",
        amountTotalCents: 501,
        currency: "USD",
        terminalStatus: "succeeded",
        occurredAt: occurredAt(3_000),
      }),
    ).rejects.toThrow("exceed");

    expect(database(repo).prepare("SELECT count(*) AS n FROM credits").get())
      .toEqual({ n: 1 });
    expect(
      database(repo)
        .prepare("SELECT count(*) AS n FROM stripe_revenue_receipts")
        .get(),
    ).toEqual({ n: 1 });
  });

  it("returns a no-write unmatched result for a refund from another payment rail", async () => {
    const repo = new SqliteRepo(":memory:");
    await expect(repo.recordStripeRevenueEvent({
      kind: "refund",
      providerEventId: "evt_unmatchedRefund0001",
      providerPaymentIntentId: "pi_unmatchedPayment0001",
      providerRefundId: "re_unmatchedRefund0001",
      amountTotalCents: 500,
      currency: "USD",
      terminalStatus: "succeeded",
      occurredAt: occurredAt(),
    })).resolves.toEqual({
      recorded: false,
      creditDeltaUsdc: 0,
      refundState: "none",
    });
    expect(database(repo).prepare("SELECT count(*) AS n FROM credits").get())
      .toEqual({ n: 0 });
    expect(
      database(repo)
        .prepare("SELECT count(*) AS n FROM stripe_revenue_receipts")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("serializes unique extraction cursors and rejects ledger mutation", async () => {
    const repo = new SqliteRepo(":memory:");
    await repo.recordStripeRevenueEvent(paymentInput());
    await repo.recordStripeRevenueEvent({
      kind: "refund",
      providerEventId: "evt_refundReceipt0004",
      providerPaymentIntentId: "pi_paymentReceipt0001",
      providerRefundId: "re_refundReceipt0004",
      amountTotalCents: 500,
      currency: "USD",
      terminalStatus: "succeeded",
      occurredAt: occurredAt(),
    });
    const db = database(repo);
    const revisions = db.prepare(
      "SELECT source_revision_at FROM stripe_revenue_receipts ORDER BY source_revision_at",
    ).all() as Array<{ source_revision_at: string }>;
    expect(revisions).toHaveLength(2);
    expect(Date.parse(revisions[1]!.source_revision_at))
      .toBeGreaterThan(Date.parse(revisions[0]!.source_revision_at));

    expect(() => db.prepare(
      "UPDATE stripe_revenue_receipts SET currency = 'EUR'",
    ).run()).toThrow("append-only");
    expect(() => db.prepare("DELETE FROM stripe_revenue_receipts").run())
      .toThrow("append-only");
  });
});
