/**
 * Gateway topup handler — Stripe-funded alternative to the x402/USDC path
 * in topup-handler.ts. Same credit ledger, same tiers,
 * different rail: a business without a crypto wallet pays once by card
 * (well above Stripe's ~$0.50 per-charge floor, so the fee overhead stays
 * sane) instead of paying per call, which nobody does economically —
 * Strumly's own Stripe products are floored at $0.99 for exactly this
 * reason.
 *
 * Server-only. Requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.
 */
import { z } from "zod";
import type Stripe from "stripe";
import type { FlowRepo } from "@/lib/db/repo";
import { TOPUP_TIERS, type TopupTier } from "./topup-handler";
import { COMMIT_TIERS, commitGrantUsdc } from "@/lib/billing";

export { TOPUP_TIERS };
export type { TopupTier };

/**
 * Card-topup tiers = the one-time TOPUP_TIERS plus the committed-use
 * COMMIT_TIERS. Both fund the same credit ledger through the same Stripe
 * Checkout session on the same route; commit tiers additionally carry a
 * bonus-credit grant (see commitGrantUsdc / the webhook handler below). The
 * x402/USDC topup path stays on TOPUP_TIERS only — the bonus is a card-rail
 * feature, not an on-chain one.
 */
export const STRIPE_TOPUP_TIERS = [...TOPUP_TIERS, ...COMMIT_TIERS] as const;
export type StripeTopupTier = (typeof STRIPE_TOPUP_TIERS)[number];

// Runtime membership check derived from the const arrays so the schema and the
// commit-detection below can never drift from the tier definitions themselves.
const STRIPE_TOPUP_TIER_VALUES: readonly number[] = STRIPE_TOPUP_TIERS;
const COMMIT_TIER_VALUES: readonly number[] = COMMIT_TIERS;

export const StripeTopupTierSchema = z
  .number()
  .refine(
    (n): n is StripeTopupTier => STRIPE_TOPUP_TIER_VALUES.includes(n),
    { message: "unsupported topup tier" },
  )
  .default(1);

const SITE_ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://agents.suedeai.ai").replace(
  /\/+$/,
  "",
);

export interface CreateSessionResult {
  ok: boolean;
  url?: string;
  error?: string;
  status?: number;
}

/** Creates a one-time Stripe Checkout Session for a gateway-credit tier. */
export async function createStripeTopupSession(
  stripe: Stripe,
  ownerId: string,
  tier: StripeTopupTier,
): Promise<CreateSessionResult> {
  const isCommit = COMMIT_TIER_VALUES.includes(tier);
  const productName = isCommit
    ? `Suede gateway credit — $${tier} (committed, +bonus)`
    : `Suede gateway credit — $${tier}`;
  // "product" tags every charge so it's filterable/reportable separately in the
  // Stripe dashboard from strumly's charges in the same shared account — a
  // lightweight alternative to a real Connect sub-account. For commit tiers we
  // also stamp the bonus grant the webhook will honor (clamped there against
  // the paid amount, so this metadata can never mint unbounded credit).
  const metadata: Record<string, string> = {
    ownerId,
    tier: String(tier),
    product: "suede-agent-studio",
  };
  if (isCommit) {
    metadata.grantUsdc = String(commitGrantUsdc(tier));
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: productName },
            unit_amount: tier * 100,
          },
          quantity: 1,
        },
      ],
      metadata,
      payment_intent_data: {
        // Refund objects do not inherit Checkout Session metadata. Tag the
        // PaymentIntent so an unlinked refund in this shared Stripe account
        // can be classified without treating another product's refund as ours.
        metadata: { product: "suede-agent-studio" },
      },
      success_url: `${SITE_ORIGIN}/flows?topup=success`,
      cancel_url: `${SITE_ORIGIN}/flows?topup=cancelled`,
    });
    if (!session.url) {
      return { ok: false, status: 500, error: "Stripe did not return a checkout URL" };
    }
    return { ok: true, url: session.url };
  } catch (error: unknown) {
    console.error("Stripe Checkout Session creation failed", error);
    return {
      ok: false,
      status: 500,
      error: "Stripe session creation failed",
    };
  }
}

export interface WebhookResult {
  ok: boolean;
  status: number;
  error?: string;
  creditedUsdc?: number;
  refundState?: "partial" | "full";
  skipped?:
    | "unsupported-event"
    | "nonterminal-event"
    | "already-recorded";
}

/**
 * Verifies and processes Stripe topup payments and refunds. Cash facts come
 * only from the signed provider object: Checkout Session amount_total/currency
 * for payments and Refund amount/currency for refunds. Gateway credit (which
 * may include a committed-use bonus) remains a separate ledger mutation.
 *
 * The repository performs the receipt + credit mutation atomically and owns
 * database-enforced idempotency. Raw Stripe ids are passed only to that private
 * ledger boundary; they are never written to the public credit ledger or
 * returned by this handler.
 */
export async function handleStripeTopupWebhook(
  stripe: Stripe,
  webhookSecret: string,
  rawBody: string,
  signature: string,
  repo: Pick<FlowRepo, "recordStripeRevenueEvent">,
): Promise<WebhookResult> {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    return { ok: false, status: 400, error: "Webhook signature verification failed" };
  }

  const occurredAt = eventOccurredAt(event.created);
  if (!occurredAt || !/^evt_[A-Za-z0-9_]+$/u.test(event.id)) {
    return { ok: true, status: 200, skipped: "nonterminal-event" };
  }

  if (
    event.type === "checkout.session.completed"
    || event.type === "checkout.session.async_payment_succeeded"
  ) {
    const session = event.data.object as Stripe.Checkout.Session;
    const ownerId = session.metadata?.ownerId;
    const paymentIntentId = providerId(session.payment_intent, "pi_");
    const amountTotalCents = session.amount_total;
    const currency = normalizedCurrency(session.currency);
    if (session.metadata?.product !== "suede-agent-studio") {
      return { ok: true, status: 200, skipped: "unsupported-event" };
    }
    if (
      session.payment_status !== "paid"
      || session.status !== "complete"
    ) {
      return { ok: true, status: 200, skipped: "nonterminal-event" };
    }
    if (
      !ownerId
      || !/^cs_[A-Za-z0-9_]+$/u.test(session.id)
      || !paymentIntentId
      || !Number.isSafeInteger(amountTotalCents)
      || (amountTotalCents ?? 0) <= 0
      || currency !== "USD"
    ) {
      return {
        ok: false,
        status: 422,
        error: "Invalid terminal Stripe topup evidence",
      };
    }

    const paidUsdc = amountTotalCents! / 100;
    const deltaUsdc = resolveGrantUsdc(session.metadata?.grantUsdc, paidUsdc);
    const product = checkoutProductAndPrice(session);

    try {
      const write = await repo.recordStripeRevenueEvent({
        kind: "payment",
        providerEventId: event.id,
        ownerId,
        providerCheckoutSessionId: session.id,
        providerPaymentIntentId: paymentIntentId,
        amountTotalCents: amountTotalCents!,
        currency,
        terminalStatus: "paid",
        providerProductId: product.productId,
        providerPriceId: product.priceId,
        creditGrantUsdc: deltaUsdc,
        occurredAt,
      });
      if (!write.recorded) {
        return { ok: true, status: 200, skipped: "already-recorded" };
      }
      return { ok: true, status: 200, creditedUsdc: write.creditDeltaUsdc };
    } catch {
      return { ok: false, status: 503, error: "billing receipt storage is not provisioned" };
    }
  }

  if (event.type === "refund.created" || event.type === "refund.updated") {
    const refund = event.data.object as Stripe.Refund;
    const paymentIntentId = providerId(refund.payment_intent, "pi_");
    const currency = normalizedCurrency(refund.currency);
    if (
      refund.status !== "succeeded"
      || !/^re_[A-Za-z0-9_]+$/u.test(refund.id)
      || !paymentIntentId
      || !Number.isSafeInteger(refund.amount)
      || refund.amount <= 0
      || currency !== "USD"
    ) {
      return { ok: true, status: 200, skipped: "nonterminal-event" };
    }

    try {
      const write = await repo.recordStripeRevenueEvent({
        kind: "refund",
        providerEventId: event.id,
        providerPaymentIntentId: paymentIntentId,
        providerRefundId: refund.id,
        amountTotalCents: refund.amount,
        currency,
        terminalStatus: "succeeded",
        occurredAt,
      });
      if (!write.recorded) {
        if (write.refundState === "none") {
          const ownership = await classifyPaymentIntent(stripe, paymentIntentId);
          if (ownership === "other") {
            return { ok: true, status: 200, skipped: "unsupported-event" };
          }
          // Ours, or temporarily unverifiable: retry until the payment receipt
          // is present. This preserves out-of-order delivery without retrying
          // unrelated refunds from the shared Stripe account.
          return {
            ok: false,
            status: 503,
            error: "billing receipt storage is not provisioned",
          };
        }
        return { ok: true, status: 200, skipped: "already-recorded" };
      }
      if (write.refundState === "none") {
        return {
          ok: false,
          status: 503,
          error: "billing receipt storage is not provisioned",
        };
      }
      return {
        ok: true,
        status: 200,
        refundState: write.refundState === "full" ? "full" : "partial",
      };
    } catch {
      // A refund that arrives before its payment receipt must be retried;
      // acknowledging it would permanently lose both the negative revenue
      // event and the credit reversal.
      return { ok: false, status: 503, error: "billing receipt storage is not provisioned" };
    }
  }

  return { ok: true, status: 200, skipped: "unsupported-event" };
}

function eventOccurredAt(createdSeconds: number): string | null {
  if (
    !Number.isSafeInteger(createdSeconds)
    || createdSeconds < Date.UTC(2000, 0, 1) / 1_000
    || createdSeconds > Date.now() / 1_000 + 5 * 60
  ) {
    return null;
  }
  return new Date(createdSeconds * 1_000).toISOString();
}

function normalizedCurrency(value: string | null | undefined): string | null {
  if (!value || !/^[A-Za-z]{3}$/u.test(value)) return null;
  return value.toUpperCase();
}

function providerId(value: unknown, prefix: "pi_" | "prod_" | "price_"): string | null {
  const candidate = typeof value === "string"
    ? value
    : typeof value === "object" && value !== null
      ? Reflect.get(value, "id")
      : null;
  if (typeof candidate !== "string") return null;
  const pattern = prefix === "price_"
    ? /^price_[A-Za-z0-9_]+$/u
    : prefix === "prod_"
      ? /^prod_[A-Za-z0-9_]+$/u
      : /^pi_[A-Za-z0-9_]+$/u;
  return pattern.test(candidate) ? candidate : null;
}

function checkoutProductAndPrice(session: Stripe.Checkout.Session): {
  productId: string | null;
  priceId: string | null;
} {
  const lineItems = Reflect.get(session, "line_items");
  const data = typeof lineItems === "object" && lineItems !== null
    ? Reflect.get(lineItems, "data")
    : null;
  const first = Array.isArray(data) ? data[0] : null;
  const price = typeof first === "object" && first !== null
    ? Reflect.get(first, "price")
    : null;
  const priceId = providerId(price, "price_");
  const product = typeof price === "object" && price !== null
    ? Reflect.get(price, "product")
    : null;
  return { productId: providerId(product, "prod_"), priceId };
}

async function classifyPaymentIntent(
  stripe: Stripe,
  paymentIntentId: string,
): Promise<"ours" | "other" | "unavailable"> {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return paymentIntent.metadata?.product === "suede-agent-studio"
      ? "ours"
      : "other";
  } catch {
    return "unavailable";
  }
}

/**
 * Resolve the credit to grant for a completed checkout.
 *
 * Committed-use tiers stamp a `grantUsdc` (bonus credit above the paid amount)
 * into the session metadata at checkout creation; one-time topups carry no such
 * field and grant 1:1. Even though webhook signature verification already
 * proves the payload came from Stripe, the grant is clamped to
 * commitGrantUsdc(paidUsdc) as defense in depth: a metadata value larger than
 * what the committed multiplier allows for the amount actually paid can never
 * mint extra credit. Absent or malformed metadata falls back to the paid
 * amount, preserving the original one-time-topup behavior exactly.
 */
function resolveGrantUsdc(rawGrant: string | undefined, paidUsdc: number): number {
  if (rawGrant === undefined) return paidUsdc;
  const parsed = Number(rawGrant);
  if (!Number.isFinite(parsed) || parsed <= 0) return paidUsdc;
  return Math.min(parsed, commitGrantUsdc(paidUsdc));
}
