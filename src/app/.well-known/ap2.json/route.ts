import { NextResponse } from "next/server";

import { buildCatalog } from "@/lib/catalog";
import { SITE_URL } from "@/lib/site";
import {
  AP2_EXTENSION_URI,
  AP2_SELLER_SUBPROFILE,
  publicAp2RuntimeStatus,
} from "@/lib/rails/ap2";

export const runtime = "nodejs";

function absoluteServiceUrl(url: string): string {
  return new URL(url, SITE_URL).toString();
}

export async function GET(): Promise<NextResponse> {
  const status = await publicAp2RuntimeStatus();
  if (!status.advertise) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const services = (await buildCatalog())
    .filter((entry) => entry.ap2 && entry.acceptsPayment && entry.publishedLive)
    .map((entry) => ({
      id: entry.id,
      slug: entry.slug,
      discoveryUrl: `${SITE_URL}/api/agents/${entry.slug}/.well-known/ap2`,
      checkoutUrl: `${SITE_URL}/api/agents/${entry.slug}/ap2/checkout`,
      runUrl: absoluteServiceUrl(entry.urls.run),
      a2aUrl: absoluteServiceUrl(entry.urls.a2a),
    }));
  return NextResponse.json({
    protocol: "AP2",
    version: "0.2",
    profile: "ap2-v0.2-experimental",
    role: "merchant",
    mode: status.mode,
    extensionUri: AP2_EXTENSION_URI,
    settlementRail: "x402-v2",
    sellerSubprofile: AP2_SELLER_SUBPROFILE,
    jwksUrl: `${SITE_URL}/.well-known/ap2-jwks.json`,
    documentationUrl: `${SITE_URL}/docs/payments#ap2`,
    services,
  }, { headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" } });
}
