/**
 * POST /api/gateway/topup/stripe
 *
 * Card-funded alternative to /api/gateway/topup (x402/USDC). Creates a
 * one-time Stripe Checkout Session for a gateway-credit tier and returns
 * the hosted checkout URL. Actual crediting happens in the webhook route
 * once Stripe confirms payment — this route never writes a credit itself.
 *
 * Auth: Authorization: Bearer <workspaceKey>, same convention as the
 * x402 topup route.
 * Body: { tier: 1 | 5 | 20 | 50 | 100 | 250 } — the one-time topup tiers plus
 * the committed-use bulk tiers (which grant bonus credit; see stripe-topup.ts).
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import Stripe from "stripe";
import {
  createStripeTopupSession,
  StripeTopupTierSchema,
  STRIPE_TOPUP_TIERS,
} from "@/lib/gateway/stripe-topup";
import {
  resolveOwnerId,
  SUEDE_OWNER_PREFIX,
  UnauthenticatedOwnerError,
} from "@/lib/auth";
import { readBoundedJsonRequest } from "@/lib/projects/api-response";

export const runtime = "nodejs";

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const h = await headers();
    const authorization = h.get("Authorization");
    const bearerOwner = extractBearer(authorization);
    if (
      (authorization !== null && bearerOwner === null)
      || bearerOwner?.startsWith(SUEDE_OWNER_PREFIX)
    ) {
      return NextResponse.json(
        { error: "Authorization required" },
        { status: 401 },
      );
    }
    // Programmatic callers may fund an explicit bearer workspace. Browser
    // callers must use verified owner resolution so a signed-in workspace is
    // stamped on Checkout instead of the stale anonymous cookie that may have
    // just been adopted.
    const ownerId = bearerOwner ?? await resolveOwnerId();

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return NextResponse.json({ error: "card topup not available: Stripe is not configured" }, { status: 503 });
    }

    const body = await readBoundedJsonRequest(req);
    if (!body.ok) {
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }
    const tierParse = StripeTopupTierSchema.safeParse(
      typeof body.data === "object" && body.data !== null ? (body.data as Record<string, unknown>).tier : undefined,
    );
    if (!tierParse.success) {
      return NextResponse.json(
        { error: `Invalid tier. Supported: ${STRIPE_TOPUP_TIERS.join(", ")}.` },
        { status: 400 },
      );
    }

    const stripe = new Stripe(secretKey);
    const result = await createStripeTopupSession(stripe, ownerId, tierParse.data);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 500 });
    }
    return NextResponse.json({ url: result.url });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json(
        { error: "Authorization required" },
        { status: error.status },
      );
    }
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("gateway topup stripe route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
