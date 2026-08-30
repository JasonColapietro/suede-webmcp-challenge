import { resolveOwnerId } from "@/lib/auth";
import {
  notFoundResponse,
  privateJson,
  projectApiErrorResponse,
} from "@/lib/projects/api-response";
import { getProjectRepo, ensureOwnedFlowContext } from "@/lib/projects/provider";
import { publicFlowWorkbookContext } from "@/lib/projects/public-workbook";
import { isOpaquePathId } from "@/lib/projects/request-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ flowId: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const ownerId = await resolveOwnerId();
    const { flowId } = await context.params;
    if (!isOpaquePathId(flowId)) return notFoundResponse();
    const repo = await getProjectRepo();
    const flowContext = await ensureOwnedFlowContext({ repo, flowId, ownerId });
    if (!flowContext) return notFoundResponse();
    const tabs = await repo.listWorkbookTabs({
      workbookId: flowContext.workbook.id,
      ownerId,
    });
    if (tabs === null) return notFoundResponse();
    return privateJson({
      context: publicFlowWorkbookContext(flowContext),
      tabs,
    });
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}
