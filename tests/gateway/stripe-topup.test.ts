/**
 * Tests for the Stripe-funded gateway topup (src/lib/gateway/stripe-topup.ts).
 * Session creation uses a fake Stripe client (no real network call). Webhook
 * verification uses a real Stripe instance's local HMAC signing/verification
 * (stripe.webhooks.generateTestHeaderString / constructEvent) — no network
 * call either, just local crypto — so the signature-verification path is
 * exercised for real, not mocked away.
 */
import { describe, it, expect, vi } from "vitest";
import Stripe from "stripe";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import {
  createStripeTopupSession,
  handleStripeTopupWebhook,
} from "@/lib/gateway/stripe-topup";
import { commitGrantUsdc } from "@/lib/billing";

function makeRepo(): SqliteRepo {
  return new SqliteRepo(":memory:");
}

function rand(): string {
  return "topup_" + Math.random().toString(36).slice(2, 8);
}

const stripe = new Stripe("sk_test_dummy_key_for_local_signing_only");
const WEBHOOK_SECRET = "whsec_test_secret";

function signedRequest(payload: string): string {
  return stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
}

function checkoutCompletedPayload(
  sessionId: string,
  ownerId: string | undefined,
  amountTotalCents: number,
  paymentIntentId = "pi_" + rand(),
  eventType:
    | "checkout.session.completed"
    | "checkout.session.async_payment_succeeded" =
      "checkout.session.completed",
): string {
  return JSON.stringify({
    id: "evt_" + rand(),
    object: "event",
    created: Math.floor(Date.now() / 1_000),
    type: eventType,
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        amount_total: amountTotalCents,
        currency: "usd",
        payment_intent: paymentIntentId,
        payment_status: "paid",
        status: "complete",
        metadata: ownerId
          ? { ownerId, tier: "5", product: "suede-agent-studio" }
          : { product: "suede-agent-studio" },
      },
    },
  });
}

/** Like checkoutCompletedPayload, but stamps a committed-use grantUsdc into metadata. */
function checkoutWithGrant(
  sessionId: string,
  ownerId: string,
  amountTotalCents: number,
  grantUsdc: string,
): string {
  return JSON.stringify({
    id: "evt_" + rand(),
    object: "event",
    created: Math.floor(Date.now() / 1_000),
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        amount_total: amountTotalCents,
        currency: "usd",
        payment_intent: "pi_" + rand(),
        payment_status: "paid",
        status: "complete",
        metadata: {
          ownerId,
          tier: String(amountTotalCents / 100),
          grantUsdc,
          product: "suede-agent-studio",
        },
      },
    },
  });
}

function refundPayload(
  refundId: string,
  paymentIntentId: string,
  amountCents: number,
  status: "pending" | "succeeded" = "succeeded",
  eventType: "refund.created" | "refund.updated" = "refund.updated",
): string {
  return JSON.stringify({
    id: "evt_" + rand(),
    object: "event",
    created: Math.floor(Date.now() / 1_000),
    type: eventType,
    data: {
      object: {
        id: refundId,
        object: "refund",
        amount: amountCents,
        currency: "usd",
        payment_intent: paymentIntentId,
        status,
      },
    },
  });
}

function stripeForRefundClassification(
  product: string | null,
  unavailable = false,
): Stripe {
  const retrieve = unavailable
    ? vi.fn().mockRejectedValue(new Error("provider unavailable"))
    : vi.fn().mockResolvedValue({
      metadata: product === null ? {} : { product },
    });
  return {
    webhooks: {
      constructEvent: stripe.webhooks.constructEvent.bind(stripe.webhooks),
    },
    paymentIntents: { retrieve },
  } as unknown as Stripe;
}

describe("createStripeTopupSession", () => {
  it("creates a payment-mode session with owner metadata and the tier as the charge amount", async () => {
    const created = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/test-session" });
    const fakeStripe = { checkout: { sessions: { create: created } } } as unknown as Stripe;

    const result = await createStripeTopupSession(fakeStripe, "owner-1", 5);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://checkout.stripe.com/test-session");

    const [params] = created.mock.calls[0] as [Stripe.Checkout.SessionCreateParams];
    expect(params.mode).toBe("payment");
    expect(params.metadata).toEqual({ ownerId: "owner-1", tier: "5", product: "suede-agent-studio" });
    expect(params.payment_intent_data?.metadata).toEqual({
      product: "suede-agent-studio",
    });
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(500);
    expect(params.line_items?.[0]?.price_data?.currency).toBe("usd");
  });

  it("keeps provider errors opaque while logging them server-side", async () => {
    const providerError = new Error(
      "card network unavailable for secret account acct_private",
    );
    const created = vi.fn().mockRejectedValue(providerError);
    const fakeStripe = { checkout: { sessions: { create: created } } } as unknown as Stripe;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const result = await createStripeTopupSession(fakeStripe, "owner-1", 1);
      expect(result).toMatchObject({
        ok: false,
        status: 500,
        error: "Stripe session creation failed",
      });
      expect(result.error).not.toContain("acct_private");
      expect(errorSpy).toHaveBeenCalledWith(
        "Stripe Checkout Session creation failed",
        providerError,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("stamps the committed-use bonus grant into metadata for a commit tier", async () => {
    const created = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/commit" });
    const fakeStripe = { checkout: { sessions: { create: created } } } as unknown as Stripe;

    const result = await createStripeTopupSession(fakeStripe, "owner-2", 50);
    expect(result.ok).toBe(true);

    const [params] = created.mock.calls[0] as [Stripe.Checkout.SessionCreateParams];
    expect(params.metadata?.grantUsdc).toBe(String(commitGrantUsdc(50)));
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(5000);
    expect(params.line_items?.[0]?.price_data?.product_data?.name).toContain("committed");
  });

  it("does not add a grant field for a one-time (non-commit) tier", async () => {
    const created = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/onetime" });
    const fakeStripe = { checkout: { sessions: { create: created } } } as unknown as Stripe;

    await createStripeTopupSession(fakeStripe, "owner-3", 5);

    const [params] = created.mock.calls[0] as [Stripe.Checkout.SessionCreateParams];
    expect(params.metadata).toEqual({ ownerId: "owner-3", tier: "5", product: "suede-agent-studio" });
    expect(params.metadata?.grantUsdc).toBeUndefined();
  });
});

describe("handleStripeTopupWebhook", () => {
  it.each([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
  ] as const)("dispatches configured terminal payment type %s", async (eventType) => {
    const recordStripeRevenueEvent = vi.fn().mockResolvedValue({
      recorded: true,
      creditDeltaUsdc: 5,
      refundState: "none",
    });
    const payload = checkoutCompletedPayload(
      "cs_test_" + rand(),
      rand(),
      500,
      "pi_" + rand(),
      eventType,
    );

    const result = await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      payload,
      signedRequest(payload),
      { recordStripeRevenueEvent },
    );

    expect(result).toMatchObject({ ok: true, creditedUsdc: 5 });
    expect(recordStripeRevenueEvent).toHaveBeenCalledOnce();
  });

  it.each([
    "refund.created",
    "refund.updated",
  ] as const)("dispatches configured terminal refund type %s", async (eventType) => {
    const recordStripeRevenueEvent = vi.fn().mockResolvedValue({
      recorded: true,
      creditDeltaUsdc: -5,
      refundState: "full",
    });
    const payload = refundPayload(
      "re_" + rand(),
      "pi_" + rand(),
      500,
      "succeeded",
      eventType,
    );

    const result = await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      payload,
      signedRequest(payload),
      { recordStripeRevenueEvent },
    );

    expect(result).toMatchObject({ ok: true, refundState: "full" });
    expect(recordStripeRevenueEvent).toHaveBeenCalledOnce();
  });

  it("credits the owner's gateway balance on a verified checkout.session.completed", async () => {
    const repo = makeRepo();
    const ownerId = rand();
    const payload = checkoutCompletedPayload("cs_test_" + rand(), ownerId, 500);
    const signature = signedRequest(payload);

    const result = await handleStripeTopupWebhook(stripe, WEBHOOK_SECRET, payload, signature, repo);
    expect(result.ok).toBe(true);
    expect(result.creditedUsdc).toBe(5);
    expect(await repo.getCreditBalance(ownerId)).toBe(5);
  });

  it("rejects a request with an invalid signature", async () => {
    const repo = makeRepo();
    const payload = checkoutCompletedPayload("cs_test_" + rand(), rand(), 500);

    const result = await handleStripeTopupWebhook(stripe, WEBHOOK_SECRET, payload, "t=1,v1=deadbeef", repo);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("does not double-credit on a redelivered webhook for the same session", async () => {
    const repo = makeRepo();
    const ownerId = rand();
    const sessionId = "cs_test_" + rand();
    const payload = checkoutCompletedPayload(sessionId, ownerId, 500);
    const signature = signedRequest(payload);

    const first = await handleStripeTopupWebhook(stripe, WEBHOOK_SECRET, payload, signature, repo);
    expect(first.creditedUsdc).toBe(5);

    const second = await handleStripeTopupWebhook(stripe, WEBHOOK_SECRET, payload, signature, repo);
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe("already-recorded");

    expect(await repo.getCreditBalance(ownerId)).toBe(5);
  });

  it("acknowledges and ignores an event type it doesn't care about", async () => {
    const repo = makeRepo();
    const payload = JSON.stringify({
      id: "evt_" + rand(),
      object: "event",
      created: Math.floor(Date.now() / 1_000),
      type: "invoice.paid",
      data: { object: {} },
    });
    const signature = signedRequest(payload);

    const result = await handleStripeTopupWebhook(stripe, WEBHOOK_SECRET, payload, signature, repo);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("unsupported-event");
  });

  it("fails closed on one of our paid sessions when private owner metadata is missing", async () => {
    const repo = makeRepo();
    const payload = checkoutCompletedPayload("cs_test_" + rand(), undefined, 500);
    const signature = signedRequest(payload);

    const result = await handleStripeTopupWebhook(stripe, WEBHOOK_SECRET, payload, signature, repo);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect(result.error).not.toContain("cs_");
  });

  it("acknowledges a paid Checkout Session for another product", async () => {
    const repo = makeRepo();
    const decoded = JSON.parse(
      checkoutCompletedPayload("cs_test_" + rand(), undefined, 500),
    ) as { data: { object: { metadata: Record<string, string> } } };
    delete decoded.data.object.metadata.product;
    const payload = JSON.stringify(decoded);

    const result = await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      payload,
      signedRequest(payload),
      repo,
    );

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("unsupported-event");
  });

  it("credits the committed-use bonus when metadata carries a valid grantUsdc", async () => {
    const repo = makeRepo();
    const ownerId = rand();
    const tier = 50;
    const grant = commitGrantUsdc(tier); // > tier: the bonus
    const payload = checkoutWithGrant("cs_test_" + rand(), ownerId, tier * 100, String(grant));
    const signature = signedRequest(payload);

    const result = await handleStripeTopupWebhook(stripe, WEBHOOK_SECRET, payload, signature, repo);
    expect(result.ok).toBe(true);
    expect(result.creditedUsdc).toBeCloseTo(grant, 6);
    expect(await repo.getCreditBalance(ownerId)).toBeCloseTo(grant, 6);
  });

  it("clamps a tampered-up grantUsdc to commitGrantUsdc(paid) so it cannot mint unbounded credit", async () => {
    const repo = makeRepo();
    const ownerId = rand();
    const tier = 50;
    // Metadata claims a wildly inflated grant; the clamp must cap it at the
    // committed multiplier applied to what was actually paid.
    const payload = checkoutWithGrant("cs_test_" + rand(), ownerId, tier * 100, "999999");
    const signature = signedRequest(payload);

    const result = await handleStripeTopupWebhook(stripe, WEBHOOK_SECRET, payload, signature, repo);
    expect(result.ok).toBe(true);
    expect(result.creditedUsdc).toBeCloseTo(commitGrantUsdc(tier), 6);
    expect(await repo.getCreditBalance(ownerId)).toBeCloseTo(commitGrantUsdc(tier), 6);
  });

  it("falls back to 1:1 credit when grantUsdc metadata is absent (one-time topup behavior)", async () => {
    const repo = makeRepo();
    const ownerId = rand();
    const payload = checkoutCompletedPayload("cs_test_" + rand(), ownerId, 500);
    const signature = signedRequest(payload);

    const result = await handleStripeTopupWebhook(stripe, WEBHOOK_SECRET, payload, signature, repo);
    expect(result.creditedUsdc).toBe(5);
    expect(await repo.getCreditBalance(ownerId)).toBe(5);
  });

  it("ignores a malformed grantUsdc and grants 1:1", async () => {
    const repo = makeRepo();
    const ownerId = rand();
    const payload = checkoutWithGrant("cs_test_" + rand(), ownerId, 500, "not-a-number");
    const signature = signedRequest(payload);

    const result = await handleStripeTopupWebhook(stripe, WEBHOOK_SECRET, payload, signature, repo);
    expect(result.creditedUsdc).toBe(5);
    expect(await repo.getCreditBalance(ownerId)).toBe(5);
  });

  it("records authoritative provider cents separately from a committed-use bonus", async () => {
    const ownerId = rand();
    const recordStripeRevenueEvent = vi.fn().mockResolvedValue({
      recorded: true,
      creditDeltaUsdc: commitGrantUsdc(50),
      refundState: "none",
    });
    const payload = checkoutWithGrant(
      "cs_test_" + rand(),
      ownerId,
      5_000,
      String(commitGrantUsdc(50)),
    );

    const result = await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      payload,
      signedRequest(payload),
      { recordStripeRevenueEvent },
    );

    expect(result.creditedUsdc).toBe(commitGrantUsdc(50));
    expect(recordStripeRevenueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountTotalCents: 5_000,
        currency: "USD",
        creditGrantUsdc: commitGrantUsdc(50),
      }),
    );
  });

  it("ignores an unpaid completed Checkout Session", async () => {
    const repo = makeRepo();
    const ownerId = rand();
    const decoded = JSON.parse(
      checkoutCompletedPayload("cs_test_" + rand(), ownerId, 500),
    ) as { data: { object: { payment_status: string } } };
    decoded.data.object.payment_status = "unpaid";
    const payload = JSON.stringify(decoded);

    const result = await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      payload,
      signedRequest(payload),
      repo,
    );

    expect(result.skipped).toBe("nonterminal-event");
    expect(await repo.getCreditBalance(ownerId)).toBe(0);
  });

  it("atomically reverses credit for partial and full verified refunds", async () => {
    const repo = makeRepo();
    const ownerId = rand();
    const paymentIntentId = "pi_" + rand();
    const payment = checkoutCompletedPayload(
      "cs_test_" + rand(),
      ownerId,
      500,
      paymentIntentId,
    );
    await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      payment,
      signedRequest(payment),
      repo,
    );

    const partial = refundPayload("re_" + rand(), paymentIntentId, 200);
    const partialResult = await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      partial,
      signedRequest(partial),
      repo,
    );
    expect(partialResult.refundState).toBe("partial");
    expect(await repo.getCreditBalance(ownerId)).toBe(3);

    const full = refundPayload("re_" + rand(), paymentIntentId, 300);
    const fullResult = await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      full,
      signedRequest(full),
      repo,
    );
    expect(fullResult.refundState).toBe("full");
    expect(await repo.getCreditBalance(ownerId)).toBe(0);
  });

  it("does not double-reverse credit when Stripe retries a refund", async () => {
    const repo = makeRepo();
    const ownerId = rand();
    const paymentIntentId = "pi_" + rand();
    const payment = checkoutCompletedPayload(
      "cs_test_" + rand(),
      ownerId,
      500,
      paymentIntentId,
    );
    await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      payment,
      signedRequest(payment),
      repo,
    );
    const refund = refundPayload("re_" + rand(), paymentIntentId, 500);

    const first = await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      refund,
      signedRequest(refund),
      repo,
    );
    const second = await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      refund,
      signedRequest(refund),
      repo,
    );

    expect(first.refundState).toBe("full");
    expect(second.skipped).toBe("already-recorded");
    expect(await repo.getCreditBalance(ownerId)).toBe(0);
  });

  it("returns a retryable failure when a refund has no private payment linkage", async () => {
    const repo = makeRepo();
    const payload = refundPayload("re_" + rand(), "pi_" + rand(), 500);

    const result = await handleStripeTopupWebhook(
      stripeForRefundClassification(null, true),
      WEBHOOK_SECRET,
      payload,
      signedRequest(payload),
      repo,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).not.toContain("pi_");
  });

  it("acknowledges an unlinked refund that belongs to another product", async () => {
    const repo = makeRepo();
    const payload = refundPayload("re_" + rand(), "pi_" + rand(), 500);

    const result = await handleStripeTopupWebhook(
      stripeForRefundClassification("another-product"),
      WEBHOOK_SECRET,
      payload,
      signedRequest(payload),
      repo,
    );

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("unsupported-event");
    expect(databaseReceiptCount(repo)).toBe(0);
  });

  it("keeps an unlinked Agent Studio refund retryable until its payment receipt arrives", async () => {
    const repo = makeRepo();
    const payload = refundPayload("re_" + rand(), "pi_" + rand(), 500);

    const result = await handleStripeTopupWebhook(
      stripeForRefundClassification("suede-agent-studio"),
      WEBHOOK_SECRET,
      payload,
      signedRequest(payload),
      repo,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("acknowledges a pending refund without changing credit", async () => {
    const repo = makeRepo();
    const payload = refundPayload(
      "re_" + rand(),
      "pi_" + rand(),
      500,
      "pending",
    );

    const result = await handleStripeTopupWebhook(
      stripe,
      WEBHOOK_SECRET,
      payload,
      signedRequest(payload),
      repo,
    );

    expect(result.skipped).toBe("nonterminal-event");
  });
});

function databaseReceiptCount(repo: SqliteRepo): number {
  const db = (
    repo as unknown as {
      db: { prepare(sql: string): { get(): { count: number } } };
    }
  ).db;
  return db.prepare(
    "SELECT count(*) AS count FROM stripe_revenue_receipts",
  ).get().count;
}
