import { resolveOwnerId, resolveReadOnlyOwnerId } from "@/lib/auth";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { googlePlayResourceMutationRefusal, rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { getResourceRepository } from "@/lib/resources/provider";
import {
  assertResourceFoundryEnabled,
  CreateResourceRequestSchema,
  ResourceFoundryService,
  resourceApiErrorResponse,
} from "@/lib/resources/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function limited(ownerId: string, request: Request): Response | null {
  for (const result of [
    checkRateLimit(`resource-create:${ownerId}`, { capacity: 12, refillPerSec: 0.2 }),
    checkRateLimit(`resource-create-ip:${ipFromRequest(request)}`, { capacity: 12, refillPerSec: 0.2 }),
  ]) {
    if (!result.allowed) return privateJson(
      { error: "rate limit exceeded", retryAfterSec: result.retryAfterSec },
      429,
      { "Retry-After": String(result.retryAfterSec) },
    );
  }
  return null;
}

export async function GET(): Promise<Response> {
  try {
    assertResourceFoundryEnabled();
    const ownerId = await resolveReadOnlyOwnerId();
    const service = new ResourceFoundryService(await getResourceRepository());
    return privateJson({ resources: await service.listProducts(ownerId) });
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const playRefusal = googlePlayResourceMutationRefusal(request);
    if (playRefusal) return playRefusal;
    assertResourceFoundryEnabled();
    rejectAuthorizationMutation(request);
    const ownerId = await resolveOwnerId();
    const refusal = limited(ownerId, request);
    if (refusal) return refusal;
    const read = await readBoundedJsonRequest(request);
    if (!read.ok) return privateJson({ error: "invalid request" }, 400);
    const body = CreateResourceRequestSchema.safeParse(read.data);
    if (!body.success) return privateJson({ error: "invalid request" }, 400);
    const service = new ResourceFoundryService(await getResourceRepository());
    return privateJson(await service.createProduct(ownerId, body.data), 201);
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}
