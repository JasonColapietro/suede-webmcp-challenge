import { resolveOwnerId } from "@/lib/auth";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { googlePlayResourceMutationRefusal, rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { getResourceRepository } from "@/lib/resources/provider";
import {
  assertResourceFoundryEnabled,
  CollectResourceSourceCandidateRequestSchema,
  ResourceFoundryService,
  resourceApiErrorResponse,
} from "@/lib/resources/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface RouteContext { readonly params: Promise<{ resourceId: string }> }

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const playRefusal = googlePlayResourceMutationRefusal(request);
    if (playRefusal) return playRefusal;
    assertResourceFoundryEnabled();
    rejectAuthorizationMutation(request);
    const ownerId = await resolveOwnerId();
    const { resourceId } = await context.params;
    if (!isOpaquePathId(resourceId)) return privateJson({ error: "not found" }, 404);
    const rate = checkRateLimit(`resource-source:${ownerId}:${resourceId}`, { capacity: 6, refillPerSec: 0.1 });
    if (!rate.allowed) return privateJson(
      { error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec }, 429,
      { "Retry-After": String(rate.retryAfterSec) },
    );
    const read = await readBoundedJsonRequest(request);
    if (!read.ok) return privateJson({ error: "invalid request" }, 400);
    const body = CollectResourceSourceCandidateRequestSchema.safeParse(read.data);
    if (!body.success) return privateJson({ error: "invalid request" }, 400);
    if (body.data.source.kind === "url") {
      const callerRate = checkRateLimit(`resource-source-url-ip:${ipFromRequest(request)}`, { capacity: 6, refillPerSec: 0.1 });
      if (!callerRate.allowed) return privateJson(
        { error: "rate limit exceeded", retryAfterSec: callerRate.retryAfterSec }, 429,
        { "Retry-After": String(callerRate.retryAfterSec) },
      );
    }
    const service = new ResourceFoundryService(await getResourceRepository());
    return privateJson(await service.collectSourceAndReplaceCandidate(ownerId, resourceId, body.data), 201);
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}
