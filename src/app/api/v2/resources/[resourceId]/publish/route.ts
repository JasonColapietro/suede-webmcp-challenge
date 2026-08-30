import { resolveOwnerId } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { googlePlayResourceMutationRefusal, rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { getProjectRepo } from "@/lib/projects/provider";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { getResourceRepository } from "@/lib/resources/provider";
import {
  PublishResourceRequestSchema,
  ResourcePublicationRefusedError,
  ResourcePublishService,
} from "@/lib/resources/publish-service";
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
    const rate = checkRateLimit(`resource-publish:${ownerId}:${resourceId}`, { capacity: 5, refillPerSec: 0.1 });
    if (!rate.allowed) return privateJson(
      { error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec }, 429,
      { "Retry-After": String(rate.retryAfterSec) },
    );
    const read = await readBoundedJsonRequest(request);
    if (!read.ok) return privateJson({ error: "invalid request" }, 400);
    const parsed = PublishResourceRequestSchema.safeParse(read.data);
    if (!parsed.success) return privateJson({ error: "invalid request" }, 400);
    const service = new ResourcePublishService({
      resourceRepo: await getResourceRepository(), flowRepo: await getRepo(),
      projectRepo: await getProjectRepo(),
    });
    return privateJson({ published: await service.publish(ownerId, resourceId, parsed.data) });
  } catch (error: unknown) {
    if (error instanceof ResourcePublicationRefusedError) {
      return privateJson({ error: "resource publication refused" }, 409);
    }
    return resourceApiErrorResponse(error);
  }
}
