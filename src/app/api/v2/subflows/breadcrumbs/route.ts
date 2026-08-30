import { resolveReadOnlyOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import {
  SubflowBreadcrumbRequestSchema,
  SubflowBreadcrumbService,
  SubflowBreadcrumbStoreUnavailableError,
  subflowBreadcrumbRequestWithinBudget,
} from "@/lib/flow/subflow-breadcrumbs";
import { methodNotAllowed } from "@/lib/flow/subflow-api-route";
import { privateJson, readCappedJsonRequest } from "@/lib/projects/api-response";
import { rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    rejectAuthorizationMutation(request);
    const read = await readCappedJsonRequest(request);
    if (!read.ok || !subflowBreadcrumbRequestWithinBudget(read.data)) {
      return privateJson({ error: "invalid request" }, 400);
    }
    const parsed = SubflowBreadcrumbRequestSchema.safeParse(read.data);
    if (!parsed.success) return privateJson({ error: "invalid request" }, 400);
    const ownerId = await resolveReadOnlyOwnerId();
    const result = await new SubflowBreadcrumbService(await getRepo()).read({
      ownerId,
      currentFlowId: parsed.data.currentFlowId,
      trail: parsed.data.trail,
    });
    return result === null
      ? privateJson({ error: "not found" }, 404)
      : privateJson(result);
  } catch (error) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: "Authentication required" }, 401);
    }
    if (error instanceof SubflowBreadcrumbStoreUnavailableError) {
      return privateJson({ error: "breadcrumb store unavailable" }, 503);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}

export const GET = () => methodNotAllowed("POST");
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
