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

interface RouteContext {
  params: Promise<{ agent: string }>;
}

export async function GET(_request: Request, { params }: RouteContext): Promise<NextResponse> {
  const status = await publicAp2RuntimeStatus();
  if (!status.advertise) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }
  const { agent } = await params;
  const entry = (await buildCatalog()).find((candidate) =>
    candidate.id === agent || candidate.slug === agent);
  if (!entry?.ap2 || !entry.acceptsPayment || !entry.publishedLive) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }
  return NextResponse.json({
    protocol: "AP2",
    version: "0.2",
    profile: "ap2-v0.2-experimental",
    role: "merchant",
    mode: status.mode,
    extensionUri: AP2_EXTENSION_URI,
    negotiationHeaders: ["A2A-Extensions", "X-A2A-Extensions"],
    sellerSubprofile: AP2_SELLER_SUBPROFILE,
    checkoutMandateVct: ["mandate.checkout.1", "mandate.checkout.open.1"],
    paymentMandateVct: ["mandate.payment.1", "mandate.payment.open.1"],
    checkoutUrl: `${SITE_URL}/api/agents/${entry.slug}/ap2/checkout`,
    runUrl: absoluteServiceUrl(entry.urls.run),
    a2aUrl: absoluteServiceUrl(entry.urls.a2a),
    jwksUrl: `${SITE_URL}/.well-known/ap2-jwks.json`,
    settlement: {
      rail: "x402-v2",
      scheme: "exact",
      network: "eip155:8453",
      amountUsdc: entry.priceUsdc,
      payTo: entry.payTo,
    },
    receipts: {
      merchant: "signed Checkout Receipt",
      payment: "provided by the credential/payment processor, not Agent Studio",
    },
  }, { headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" } });
}
