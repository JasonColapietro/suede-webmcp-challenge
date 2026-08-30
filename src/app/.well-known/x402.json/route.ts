/**
 * Compatibility alias for crawlers and clients that look for
 * `/.well-known/x402.json` instead of `/.well-known/x402`.
 */
import { NextResponse } from "next/server";
import { buildX402DiscoveryIndex } from "../x402/route";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await buildX402DiscoveryIndex(), {
      headers: { "cache-control": "public, max-age=60" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
