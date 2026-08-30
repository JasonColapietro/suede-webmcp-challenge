import { NextResponse } from "next/server";
import { resolveOperatingSystemAccess } from "@/lib/company/operating-system/authorization";
import { discoverGooglePlaces, ProspectAdapterUnavailableError } from "@/lib/company/prospect-engine/adapters";
import { DiscoverProspectsRequestSchema } from "@/lib/company/prospect-engine/contracts";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const access = await resolveOperatingSystemAccess();
    if (access.kind === "signed-out") return privateJson({ error: "Authentication required" }, 401);
    if (access.kind === "forbidden") return privateJson({ error: "not found" }, 404);
    const limited = checkRateLimit(`prospect-discovery:${access.ownerId}`, { capacity: 5, refillPerSec: 1 / 12 });
    if (!limited.allowed) return privateJson({ error: "rate limited" }, 429, { "Retry-After": String(limited.retryAfterSec) });
    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return privateJson({ error: "invalid request" }, 400);
    const parsed = DiscoverProspectsRequestSchema.safeParse(body.data);
    if (!parsed.success) return privateJson({ error: "invalid request" }, 400);
    const candidates = await discoverGooglePlaces(parsed.data.query);
    return privateJson({ candidates, ephemeral: true, attribution: "Google Maps" });
  } catch (error: unknown) {
    if (error instanceof ProspectAdapterUnavailableError) {
      return privateJson({ error: error.message, manualImportAvailable: true }, 503);
    }
    return privateJson({ error: "discovery unavailable", manualImportAvailable: true }, 502);
  }
}
