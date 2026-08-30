import { resolveOwnerId } from "@/lib/auth";
import {
  invalidRequestResponse,
  notFoundResponse,
  parseJsonRequest,
  privateJson,
  projectApiErrorResponse,
} from "@/lib/projects/api-response";
import { rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { getProjectRepo } from "@/lib/projects/provider";
import {
  isOpaquePathId,
  ReorderWorkbookTabsRequestSchema,
} from "@/lib/projects/request-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ workbookId: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const ownerId = await resolveOwnerId();
    const { workbookId } = await context.params;
    if (!isOpaquePathId(workbookId)) return notFoundResponse();
    const repo = await getProjectRepo();
    const tabs = await repo.listWorkbookTabs({ workbookId, ownerId });
    return tabs === null ? notFoundResponse() : privateJson({ tabs });
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    rejectAuthorizationMutation(request);
    const ownerId = await resolveOwnerId();
    const { workbookId } = await context.params;
    if (!isOpaquePathId(workbookId)) return notFoundResponse();
    const parsed = await parseJsonRequest(request, ReorderWorkbookTabsRequestSchema);
    if (!parsed.ok) return invalidRequestResponse();
    const repo = await getProjectRepo();
    const tabs = await repo.reorderWorkbookTabs({
      workbookId,
      ownerId,
      tabIds: parsed.data.tabIds,
    });
    return tabs === null ? notFoundResponse() : privateJson({ tabs });
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}
