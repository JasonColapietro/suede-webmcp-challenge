import { resolveReadOnlyOwnerId } from "@/lib/auth";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import { privateJson } from "@/lib/projects/api-response";
import { getResourceRepository } from "@/lib/resources/provider";
import {
  assertResourceFoundryEnabled,
  ResourceFoundryService,
  resourceApiErrorResponse,
} from "@/lib/resources/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { readonly params: Promise<{ resourceId: string }> }

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    assertResourceFoundryEnabled();
    const ownerId = await resolveReadOnlyOwnerId();
    const { resourceId } = await context.params;
    if (!isOpaquePathId(resourceId)) return privateJson({ error: "not found" }, 404);
    const service = new ResourceFoundryService(await getResourceRepository());
    return privateJson({ trust: await service.trust(ownerId, resourceId) });
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}
