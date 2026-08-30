/**
 * POST /api/gateway/topup/stripe/webhook
 *
 * Stripe webhook receiver for the card-funded gateway topup. Verifies the
 * Stripe-Signature header against the RAW request body (Stripe's signature
 * covers the exact bytes sent, so this must never route through a JSON
 * body parser first). Terminal paid Checkout Sessions atomically append a
 * private cash receipt and gateway credit; terminal Refund events append a
 * negative cash receipt and reverse the corresponding granted credit.
 *
 * Configure this exact URL as a Stripe webhook endpoint listening for
 * checkout.session.completed, checkout.session.async_payment_succeeded,
 * refund.created, and refund.updated, with STRIPE_WEBHOOK_SECRET set to the
 * signing secret Stripe gives you for it.
 */
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getRepo } from "@/lib/db/repo";
import { handleStripeTopupWebhook } from "@/lib/gateway/stripe-topup";

export const runtime = "nodejs";

/** Generous but bounded — a Checkout Session event is a few KB, never more. */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export async function POST(req: Request): Promise<NextResponse> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing stripe-signature header" }, { status: 400 });
  }

  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  const stripe = new Stripe(secretKey);
  const repo = await getRepo();

  const result = await handleStripeTopupWebhook(stripe, webhookSecret, rawBody, signature, repo);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    received: true,
    ...(result.creditedUsdc !== undefined ? { creditedUsdc: result.creditedUsdc } : {}),
    ...(result.refundState ? { refundState: result.refundState } : {}),
  });
}
