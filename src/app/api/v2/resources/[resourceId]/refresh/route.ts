import { resolveOwnerId } from "@/lib/auth";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { googlePlayResourceMutationRefusal, rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { getResourceRepository } from "@/lib/resources/provider";
import {
  assertResourceFoundryEnabled,
  RefreshResourceSourceRequestSchema,
  RejectResourceRefreshRequestSchema,
  RefreshResourceRequestSchema,
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
    const rate = checkRateLimit(`resource-refresh:${ownerId}:${resourceId}`, { capacity: 6, refillPerSec: 0.1 });
    if (!rate.allowed) return privateJson(
      { error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec }, 429,
      { "Retry-After": String(rate.retryAfterSec) },
    );
    const read = await readBoundedJsonRequest(request);
    if (!read.ok) return privateJson({ error: "invalid request" }, 400);
    if (read.data && typeof read.data === "object" && !Array.isArray(read.data) &&
        Reflect.get(read.data, "action") === "recollect") {
      const body = RefreshResourceSourceRequestSchema.safeParse(Object.fromEntries(
        Object.entries(read.data as Record<string, unknown>).filter(([key]) => key !== "action"),
      ));
      if (!body.success) return privateJson({ error: "invalid request" }, 400);
      if (body.data.source.kind === "url") {
        const callerRate = checkRateLimit(`resource-refresh-url-ip:${ipFromRequest(request)}`, { capacity: 6, refillPerSec: 0.1 });
        if (!callerRate.allowed) return privateJson(
          { error: "rate limit exceeded", retryAfterSec: callerRate.retryAfterSec }, 429,
          { "Retry-After": String(callerRate.retryAfterSec) },
        );
      }
      return privateJson(await new ResourceFoundryService(await getResourceRepository())
        .refreshFromSource(ownerId, resourceId, body.data), 201);
    }
    if (read.data && typeof read.data === "object" && !Array.isArray(read.data) &&
        Reflect.get(read.data, "action") === "reject") {
      const body = RejectResourceRefreshRequestSchema.safeParse(Object.fromEntries(
        Object.entries(read.data as Record<string, unknown>).filter(([key]) => key !== "action"),
      ));
      if (!body.success) return privateJson({ error: "invalid request" }, 400);
      return privateJson(await new ResourceFoundryService(await getResourceRepository())
        .rejectRefreshCandidate(ownerId, resourceId, body.data), 200);
    }
    const body = RefreshResourceRequestSchema.safeParse(read.data);
    if (!body.success) return privateJson({ error: "invalid request" }, 400);
    return privateJson(await new ResourceFoundryService(await getResourceRepository())
      .refresh(ownerId, resourceId, body.data), 201);
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}
