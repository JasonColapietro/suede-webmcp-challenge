import { resolveOwnerId, resolveReadOnlyOwnerId } from "@/lib/auth";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { googlePlayResourceMutationRefusal, rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { getResourceRepository } from "@/lib/resources/provider";
import {
  ApproveResourceCandidateRequestSchema,
  assertResourceFoundryEnabled,
  ResourceFoundryService,
  resourceApiErrorResponse,
  ResourcePackReferenceSchema,
} from "@/lib/resources/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { readonly params: Promise<{ resourceId: string }> }

function queryReference(request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== "packVersionId" && key !== "semanticHash") ||
      params.getAll("packVersionId").length !== 1 || params.getAll("semanticHash").length !== 1) return null;
  const parsed = ResourcePackReferenceSchema.safeParse({
    packVersionId: params.get("packVersionId"), semanticHash: params.get("semanticHash"),
  });
  return parsed.success ? parsed.data : null;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertResourceFoundryEnabled();
    const ownerId = await resolveReadOnlyOwnerId();
    const { resourceId } = await context.params;
    if (!isOpaquePathId(resourceId)) return privateJson({ error: "not found" }, 404);
    const reference = queryReference(request);
    if (!reference) return privateJson({ error: "not found" }, 404);
    const service = new ResourceFoundryService(await getResourceRepository());
    return privateJson({ pack: await service.getPack(ownerId, resourceId, reference) });
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const playRefusal = googlePlayResourceMutationRefusal(request);
    if (playRefusal) return playRefusal;
    assertResourceFoundryEnabled();
    rejectAuthorizationMutation(request);
    const ownerId = await resolveOwnerId();
    const { resourceId } = await context.params;
    if (!isOpaquePathId(resourceId)) return privateJson({ error: "not found" }, 404);
    const rate = checkRateLimit(`resource-approve:${ownerId}:${resourceId}`, { capacity: 10, refillPerSec: 0.2 });
    if (!rate.allowed) return privateJson(
      { error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec }, 429,
      { "Retry-After": String(rate.retryAfterSec) },
    );
    const read = await readBoundedJsonRequest(request);
    if (!read.ok) return privateJson({ error: "invalid request" }, 400);
    const body = ApproveResourceCandidateRequestSchema.safeParse(read.data);
    if (!body.success) return privateJson({ error: "invalid request" }, 400);
    const service = new ResourceFoundryService(await getResourceRepository());
    return privateJson({ pack: await service.approveCandidate(ownerId, resourceId, body.data) });
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}
