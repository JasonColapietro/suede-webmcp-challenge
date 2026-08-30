/**
 * Public machine-readable registry of protocol providers and discovery venues.
 * GET /api/providers — which agent-commerce protocols the studio speaks, what
 * is implemented, the dated receipt, and where each integration is verifiable.
 * Static registry data only: no database access, no catalog build.
 */
import { NextResponse } from "next/server";
import { PROTOCOL_PROVIDERS } from "@/lib/distribution/providers";
import { DISCOVERY_VENUES } from "@/lib/distribution/venues";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";

function absolute(path: string): string {
  return path.startsWith("http") ? path : `${SITE_URL}${path}`;
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      service: "Suede Agent Studio",
      description:
        "Agent-commerce protocols implemented by this studio, each with a dated receipt and a live verification path, plus the discovery venues where launched agents get listed.",
      site: SITE_URL,
      catalog: `${SITE_URL}/api/catalog`,
      providers: PROTOCOL_PROVIDERS.map((provider) => ({
        ...provider,
        endpoints: provider.endpoints.map(absolute),
        receipt: { ...provider.receipt, verifyUrl: absolute(provider.receipt.verifyUrl) },
      })),
      venues: DISCOVERY_VENUES,
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
