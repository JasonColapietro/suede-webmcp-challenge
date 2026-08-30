/**
 * GET /api/agents/[agent]/discovery
 *
 * Owner-only discovery console data: readiness facts, the venue registry, the
 * recorded submission receipts, and the generated-from-live-catalog payloads.
 * Read-only — auth mirrors the settlement route's read variant, and readiness
 * itself enforces ownership (a non-owner gets 404, so agent existence never
 * leaks).
 */
import { NextResponse } from "next/server";
import { resolveReadOnlyOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { buildCatalog, type CatalogEntry } from "@/lib/catalog";
import { DISCOVERY_VENUES } from "@/lib/distribution/venues";
import {
  buildAwesomeListLine,
  buildDiscoveryIssueBody,
  buildPaymarketOutreach,
  buildPaymarketYaml,
  buildSatringPayload,
  buildServiceDescriptor,
  buildX402ScoutRegisterBody,
  NoPayoutWalletError,
  type SatringPayload,
  type X402ScoutRegisterBody,
} from "@/lib/distribution/payloads";
import {
  checkAgentDiscoveryReadiness,
  DiscoveryAgentNotFoundError,
} from "@/lib/distribution/readiness";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ agent: string }>;
}

/** Build the per-agent asset, or null when the agent has no payout wallet yet. */
function safePayload<T>(build: () => T): T | null {
  try {
    return build();
  } catch (error) {
    if (error instanceof NoPayoutWalletError) return null;
    throw error;
  }
}

export async function GET(_req: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const owner = await resolveReadOnlyOwnerId();
    const { agent: agentParam } = await params;

    const readiness = await checkAgentDiscoveryReadiness(agentParam, owner);

    const repo = await getRepo();
    const [catalog, listings] = await Promise.all([
      buildCatalog(),
      repo.listAgentListings(readiness.agentId),
    ]);
    const entry: CatalogEntry | undefined = catalog.find(
      (e) => e.id === readiness.agentId || e.slug === readiness.slug,
    );

    const service = buildServiceDescriptor();
    const x402scoutRegister: X402ScoutRegisterBody | null = entry
      ? safePayload(() => buildX402ScoutRegisterBody(entry))
      : null;
    const satringBody: SatringPayload | null = entry
      ? safePayload(() => buildSatringPayload(entry))
      : null;

    const payloads = {
      serviceDescriptor: service,
      x402scoutRegister,
      satring: {
        url: "https://satring.com/api/v1/services",
        requiresPaymentV2: true,
        costUsdc: 0.5,
        body: satringBody,
      },
      awesomeListLine: buildAwesomeListLine(service),
      discoveryIssue: buildDiscoveryIssueBody(service, catalog),
      agenticMarketOutreach: buildPaymarketOutreach(service, catalog),
      payshYaml: buildPaymarketYaml(catalog),
    };

    return NextResponse.json(
      {
        agentId: readiness.agentId,
        slug: readiness.slug,
        readiness,
        venues: DISCOVERY_VENUES,
        listings,
        payloads,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error: unknown) {
    if (error instanceof DiscoveryAgentNotFoundError) {
      return NextResponse.json({ error: "agent not found" }, { status: 404 });
    }
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("agents discovery route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
