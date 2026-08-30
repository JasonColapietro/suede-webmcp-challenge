/**
 * Curated service feed for autonomous buyers.
 *
 * Unlike /api/catalog, which contains every eligible customer-published
 * agent, this route is an explicit Suede-operated shelf. Exact-slug matching
 * happens in buildCatalog(), so a customer copy of the same template cannot
 * inherit the curation claim.
 */
import { NextResponse } from "next/server";
import { buildCatalog } from "@/lib/catalog";
import { listCuratedBusinessServiceContracts } from "@/lib/curated-business-services";
import { PUBLIC_PAYMENT_PROJECTION } from "@/lib/public-payment-readiness";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";

function readiness(entry: Awaited<ReturnType<typeof buildCatalog>>[number]) {
  const hasSettledCalls = entry.settledCalls > 0;
  return {
    state: entry.paymentState,
    publishedLive: entry.publishedLive,
    acceptsPayment: entry.acceptsPayment,
    previewAvailable: entry.previewAvailable,
    hasSettledCalls,
    settledCalls: entry.settledCalls,
    lastCallAt: entry.lastCallAt,
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const entries = await buildCatalog();
    const absolute = (value: string): string => value.startsWith("http") ? value : `${SITE_URL}${value}`;
    const rank = new Map(
      listCuratedBusinessServiceContracts().map((contract, index) => [contract.slug, index]),
    );
    const services = entries
      .filter((entry) => entry.curation?.collection === "business-operations")
      .sort((a, b) => (rank.get(a.slug) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.slug) ?? Number.MAX_SAFE_INTEGER))
      .map((entry) => ({
        ...entry,
        readiness: readiness(entry),
        urls: {
          ...Object.fromEntries(
            Object.entries(entry.urls).map(([key, value]) => [key, absolute(value)]),
          ),
          a2aSend: `${absolute(entry.urls.a2a)}/message:send`,
        },
      }));
    const ap2 = services.find((entry) => entry.ap2)?.ap2;
    return NextResponse.json(
      {
        service: "Suede Business Operations",
        operator: "Suede Labs AI",
        description:
          "Curated published business decision services with typed contracts, listed per-call prices, current call readiness, and explicit human-review boundaries.",
        collection: "business-operations",
        site: SITE_URL,
        readinessProjectionVersion: PUBLIC_PAYMENT_PROJECTION.version,
        count: services.length,
        historicallySettledServiceCount: services.filter(
          (entry) => entry.readiness.hasSettledCalls,
        ).length,
        ...(ap2 ? { ap2 } : {}),
        services,
      },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch (error: unknown) {
    console.error("curated services route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
