import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { readBoundedJsonRequest } from "@/lib/projects/api-response";
import { resolveModerationReviewer } from "@/lib/moderation/reviewer";
import { PROMO_CLAIM_STATUSES } from "@/lib/flow/nodes/suede/promoClaims";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" } as const;

const PROMO_API_BASE = "https://promo.suedeai.ai/api/agent";

const StatusFilterSchema = z
  .string()
  .transform((raw) => raw.split(",").map((part) => part.trim()).filter(Boolean))
  .refine(
    (parts) =>
      parts.length > 0 &&
      parts.every((part) => (PROMO_CLAIM_STATUSES as readonly string[]).includes(part)),
    { message: "invalid status filter" },
  );

const ResolveBodySchema = z.object({
  claimId: z.string().uuid(),
  resolution: z.enum(["approved", "rejected", "forfeited"]),
  note: z.string().max(500).optional(),
});

/** The Promo agent credential, or null when this deployment has none. */
function promoKey(): string | null {
  const key = process.env.PROMO_AGENT_KEY;
  return key && key.length > 0 ? key : null;
}

/**
 * Missing-credential response. Without this the proxy forwards `Bearer `
 * (empty), Promo answers 401, and the reviewer sees an upstream auth failure
 * that reads like a Promo problem rather than missing local config. 503 because
 * the fault is this deployment's, not the caller's. Only ever reachable after
 * the reviewer gate above, so it never discloses config state to the public.
 */
function promoUnconfigured(): NextResponse {
  console.error("[promo-claims] PROMO_AGENT_KEY is not configured");
  return NextResponse.json(
    {
      error: "promo_not_configured",
      detail: "PROMO_AGENT_KEY is not set on this deployment.",
    },
    { status: 503, headers: PRIVATE_HEADERS },
  );
}

/**
 * Reviewer-gated proxy to Promo's agent endpoints. The agent key stays
 * server-side; Promo remains the system of record and nothing about the
 * claim lifecycle is stored here.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const reviewer = await resolveModerationReviewer();
    if (!reviewer) {
      return NextResponse.json({ error: "reviewer_only" }, { status: 403, headers: PRIVATE_HEADERS });
    }

    const url = new URL(request.url);
    const rawStatus = url.searchParams.get("status") ?? "inconclusive,disputed";
    const statuses = StatusFilterSchema.safeParse(rawStatus);
    if (!statuses.success) {
      return NextResponse.json({ error: "invalid request" }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const campaignId = url.searchParams.get("campaignId");
    if (campaignId && !z.string().uuid().safeParse(campaignId).success) {
      return NextResponse.json({ error: "invalid request" }, { status: 400, headers: PRIVATE_HEADERS });
    }

    const key = promoKey();
    if (!key) return promoUnconfigured();

    const query = new URLSearchParams({ status: statuses.data.join(",") });
    if (campaignId) query.set("campaignId", campaignId);

    const upstream = await fetch(`${PROMO_API_BASE}/claims?${query.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    const body: unknown = await upstream.json().catch(() => ({ error: "upstream_unreadable" }));
    return NextResponse.json(body, { status: upstream.status, headers: PRIVATE_HEADERS });
  } catch (error: unknown) {
    console.error("promo claims read failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: PRIVATE_HEADERS });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const reviewer = await resolveModerationReviewer();
    if (!reviewer) {
      return NextResponse.json({ error: "reviewer_only" }, { status: 403, headers: PRIVATE_HEADERS });
    }

    const limit = checkRateLimit(`promo-claim-resolve:${reviewer}`, {
      capacity: 30,
      refillPerSec: 0.5,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded.", retryAfterSec: limit.retryAfterSec },
        {
          status: 429,
          headers: { ...PRIVATE_HEADERS, "Retry-After": String(limit.retryAfterSec) },
        },
      );
    }

    const body = await readBoundedJsonRequest(request);
    if (!body.ok) {
      return NextResponse.json({ error: "invalid request" }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const parsed = ResolveBodySchema.safeParse(body.data);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid request" }, { status: 400, headers: PRIVATE_HEADERS });
    }

    const key = promoKey();
    if (!key) return promoUnconfigured();

    const upstream = await fetch(`${PROMO_API_BASE}/resolve-claim`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        claimId: parsed.data.claimId,
        resolution: parsed.data.resolution,
        reviewer,
        note: parsed.data.note ?? null,
      }),
      cache: "no-store",
    });
    const result: unknown = await upstream.json().catch(() => ({ error: "upstream_unreadable" }));
    return NextResponse.json(result, { status: upstream.status, headers: PRIVATE_HEADERS });
  } catch (error: unknown) {
    console.error("promo claim resolution failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: PRIVATE_HEADERS });
  }
}
