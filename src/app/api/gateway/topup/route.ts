/**
 * POST /api/gateway/topup
 *
 * x402-PAID endpoint: pay USDC to add gateway credit.
 * Auth: Authorization: Bearer <workspaceKey>
 * Query: ?tier=1|5|20 (USDC amount; default 1)
 *
 * Without x-payment header → 402 challenge with tiers.
 * With valid x-payment → verifies + settles → credits owner's balance.
 *
 * payTo is always the Suede seller wallet (X402_SELLER_WALLET_ADDRESS env).
 * Returns 503 { error: "billing not provisioned" } when credits table absent.
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getRepo } from "@/lib/db/repo";
import { handleGatewayTopup, TopupTierSchema } from "@/lib/gateway/topup-handler";

export const runtime = "nodejs";

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const h = await headers();
    // Same deliberate x-owner-id fallback as the card route — see the comment
    // in ./stripe/route.ts for why topping up accepts it and the LLM gateway
    // does not.
    const ownerId = extractBearer(h.get("Authorization")) ?? h.get("x-owner-id");
    if (!ownerId) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }

    const url = new URL(req.url);
    const rawTier = url.searchParams.get("tier");
    const tierParse = TopupTierSchema.safeParse(rawTier !== null ? Number(rawTier) : undefined);
    if (!tierParse.success) {
      return NextResponse.json(
        { error: "Invalid tier. Use ?tier=1, ?tier=5, or ?tier=20." },
        { status: 400 },
      );
    }
    const tier = tierParse.data;

    const paymentHeader = req.headers.get("x-payment");
    const repo = await getRepo();

    const result = await handleGatewayTopup(ownerId, tier, paymentHeader, repo);

    if (!result.ok) {
      if (result.status === 402) {
        // Machine-readable 402 with topup instructions.
        return NextResponse.json(
          {
            x402Version: result.x402Version,
            error: result.error,
            accepts: result.accepts,
          },
          {
            status: 402,
            headers: {
              Link: `<${(process.env.NEXT_PUBLIC_SITE_URL ?? "https://agents.suedeai.ai").replace(/\/+$/, "")}/.well-known/x402>; rel="x402-discovery"; type="application/json"`,
            },
          },
        );
      }
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      creditsAdded: result.creditsAdded,
      transaction: result.transaction,
      payer: result.payer,
    });
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("gateway topup route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
