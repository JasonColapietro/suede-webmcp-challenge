/**
 * Workspace claim — move this browser onto an existing workspace by pasting
 * its key (the owner id, treated as a bearer secret). The middleware skips
 * cookie-minting on this path so the Set-Cookie below is authoritative.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { isCanonicalAnonymousOwnerId } from "@/lib/anonymous-owner";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

const OWNER_COOKIE = "agx_owner";
const ONE_YEAR_S = 60 * 60 * 24 * 365;

/**
 * A workspace key IS the bearer secret for a workspace, and this route accepts
 * one guess per request with no other gate, so an unlimited endpoint is free
 * online guessing against the whole key space. A UUIDv4 is far too large to
 * brute force, but the limit also caps the blast radius of a leaked-key
 * spraying attempt and of accidental client retry storms. Per-IP, matching the
 * webhook-revoke bucket shape.
 */
const CLAIM_RATE_LIMIT = Object.freeze({ capacity: 10, refillPerSec: 0.2 });

const claimSchema = z.object({
  token: z.string().refine(isCanonicalAnonymousOwnerId),
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const limit = checkRateLimit(`claim-ip:${ipFromRequest(request)}`, CLAIM_RATE_LIMIT);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
      );
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = claimSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "token must be a workspace key (UUID)." },
        { status: 400 },
      );
    }
    const response = NextResponse.json({ ok: true });
    response.cookies.set({
      name: OWNER_COOKIE,
      value: parsed.data.token,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: ONE_YEAR_S,
    });
    return response;
  } catch (error: unknown) {
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("me claim route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
