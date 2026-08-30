import { resolveOwnerId } from "@/lib/auth";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { googlePlayResourceMutationRefusal, rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { getResourceRepository } from "@/lib/resources/provider";
import {
  assertResourceFoundryEnabled,
  ReplaceResourceCandidateRequestSchema,
  ResourceFoundryService,
  resourceApiErrorResponse,
} from "@/lib/resources/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const rate = checkRateLimit(`resource-records:${ownerId}:${resourceId}`, { capacity: 20, refillPerSec: 0.5 });
    if (!rate.allowed) return privateJson(
      { error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec }, 429,
      { "Retry-After": String(rate.retryAfterSec) },
    );
    const read = await readBoundedJsonRequest(request);
    if (!read.ok) return privateJson({ error: "invalid request" }, 400);
    const body = ReplaceResourceCandidateRequestSchema.safeParse(read.data);
    if (!body.success) return privateJson({ error: "invalid request" }, 400);
    const service = new ResourceFoundryService(await getResourceRepository());
    return privateJson({ candidate: await service.replaceCandidate(ownerId, resourceId, body.data) }, 201);
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}
