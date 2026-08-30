import { resolveOwnerId } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { googlePlayResourceMutationRefusal, rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { getProjectRepo } from "@/lib/projects/provider";
import { checkRateLimit } from "@/lib/rate-limit";
import { getResourceRepository } from "@/lib/resources/provider";
import { MaterializeResourceRequestSchema, ResourcePublishService } from "@/lib/resources/publish-service";
import { assertResourceFoundryEnabled, resourceApiErrorResponse } from "@/lib/resources/service";

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
    const rate = checkRateLimit(`resource-materialize:${ownerId}:${resourceId}`, { capacity: 10, refillPerSec: 0.25 });
    if (!rate.allowed) return privateJson(
      { error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec }, 429,
      { "Retry-After": String(rate.retryAfterSec) },
    );
    const read = await readBoundedJsonRequest(request);
    if (!read.ok || !MaterializeResourceRequestSchema.safeParse(read.data).success) {
      return privateJson({ error: "invalid request" }, 400);
    }
    const service = new ResourcePublishService({
      resourceRepo: await getResourceRepository(), flowRepo: await getRepo(),
      projectRepo: await getProjectRepo(),
    });
    const materialized = await service.materialize(ownerId, resourceId);
    return privateJson({
      materialized: {
        flowId: materialized.flowId,
        resourceProductId: materialized.product.id,
        packVersionId: materialized.pack.packVersionId,
        semanticHash: materialized.semanticHash,
        graph: materialized.graph,
      },
    });
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}
