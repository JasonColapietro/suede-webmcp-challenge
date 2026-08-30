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
  RenameWorkbookTabRequestSchema,
} from "@/lib/projects/request-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ workbookId: string; tabId: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    rejectAuthorizationMutation(request);
    const ownerId = await resolveOwnerId();
    const { workbookId, tabId } = await context.params;
    if (!isOpaquePathId(workbookId) || !isOpaquePathId(tabId)) return notFoundResponse();
    const parsed = await parseJsonRequest(request, RenameWorkbookTabRequestSchema);
    if (!parsed.ok) return invalidRequestResponse();
    const repo = await getProjectRepo();
    const tab = await repo.renameWorkbookTab({
      workbookId,
      tabId,
      ownerId,
      title: parsed.data.title,
    });
    return tab === null ? notFoundResponse() : privateJson({ tab });
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}
