import { resolveOwnerId, SUEDE_OWNER_PREFIX, UnauthenticatedOwnerError } from "@/lib/auth";
import { isCanonicalAnonymousOwnerId } from "@/lib/anonymous-owner";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { googlePlayResourceMutationRefusal, rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { getResourceRepository } from "@/lib/resources/provider";
import {
  assertResourceFoundryEnabled,
  ImportSiteAgentResourceRequestSchema,
  ResourceFoundryService,
  resourceApiErrorResponse,
} from "@/lib/resources/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  try {
    const playRefusal = googlePlayResourceMutationRefusal(request);
    if (playRefusal) return playRefusal;
    assertResourceFoundryEnabled();
    rejectAuthorizationMutation(request);
    const ipRate = checkRateLimit(
      `resource-site-import-ip:${ipFromRequest(request)}`,
      { capacity: 4, refillPerSec: 0.05 },
    );
    if (!ipRate.allowed) return privateJson(
      { error: "rate limit exceeded", retryAfterSec: ipRate.retryAfterSec },
      429,
      { "Retry-After": String(ipRate.retryAfterSec) },
    );

    const ownerId = await resolveOwnerId();
    if (!ownerId.startsWith(SUEDE_OWNER_PREFIX) && !isCanonicalAnonymousOwnerId(ownerId)) {
      throw new UnauthenticatedOwnerError();
    }
    const ownerRate = checkRateLimit(
      `resource-site-import:${ownerId}`,
      { capacity: 4, refillPerSec: 0.05 },
    );
    if (!ownerRate.allowed) return privateJson(
      { error: "rate limit exceeded", retryAfterSec: ownerRate.retryAfterSec },
      429,
      { "Retry-After": String(ownerRate.retryAfterSec) },
    );
    const read = await readBoundedJsonRequest(request);
    if (!read.ok) return privateJson({ error: "invalid request" }, 400);
    const body = ImportSiteAgentResourceRequestSchema.safeParse(read.data);
    if (!body.success) return privateJson({ error: "invalid request" }, 400);
    const service = new ResourceFoundryService(await getResourceRepository());
    const imported = await service.importSiteAgentDraft(ownerId, body.data);
    return privateJson({
      ...imported,
      redirectTo: `/resources/${encodeURIComponent(imported.resourceId)}?tab=sources`,
    }, 201);
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}
