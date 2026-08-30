import { resolveOwnerId, resolveReadOnlyOwnerId } from "@/lib/auth";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { googlePlayResourceMutationRefusal, rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { getResourceRepository } from "@/lib/resources/provider";
import {
  assertResourceFoundryEnabled,
  ResourceFoundryService,
  resourceApiErrorResponse,
  UpdateResourceRequestSchema,
} from "@/lib/resources/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { readonly params: Promise<{ resourceId: string }> }

function resourceIdOrNotFound(value: unknown): string {
  if (!isOpaquePathId(value)) throw new (class extends Error { readonly opaqueNotFound = true; })();
  return value;
}

function errorResponse(error: unknown): Response {
  if (error && typeof error === "object" && "opaqueNotFound" in error) return privateJson({ error: "not found" }, 404);
  return resourceApiErrorResponse(error);
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    assertResourceFoundryEnabled();
    const ownerId = await resolveReadOnlyOwnerId();
    const resourceId = resourceIdOrNotFound((await context.params).resourceId);
    const service = new ResourceFoundryService(await getResourceRepository());
    return privateJson({ resource: await service.getProduct(ownerId, resourceId) });
  } catch (error: unknown) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const playRefusal = googlePlayResourceMutationRefusal(request);
    if (playRefusal) return playRefusal;
    assertResourceFoundryEnabled();
    rejectAuthorizationMutation(request);
    const ownerId = await resolveOwnerId();
    const resourceId = resourceIdOrNotFound((await context.params).resourceId);
    const rate = checkRateLimit(`resource-update:${ownerId}:${resourceId}`, { capacity: 20, refillPerSec: 0.5 });
    if (!rate.allowed) return privateJson(
      { error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec }, 429,
      { "Retry-After": String(rate.retryAfterSec) },
    );
    const read = await readBoundedJsonRequest(request);
    if (!read.ok) return privateJson({ error: "invalid request" }, 400);
    const body = UpdateResourceRequestSchema.safeParse(read.data);
    if (!body.success) return privateJson({ error: "invalid request" }, 400);
    const service = new ResourceFoundryService(await getResourceRepository());
    return privateJson({ resource: await service.updateDraft(ownerId, resourceId, body.data) });
  } catch (error: unknown) {
    return errorResponse(error);
  }
}
