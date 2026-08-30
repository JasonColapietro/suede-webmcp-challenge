import {
  invalidRequestResponse,
  notFoundResponse,
  privateJson,
  projectApiErrorResponse,
} from "@/lib/projects/api-response";
import { ensureOwnedFlowContext, getProjectRepo } from "@/lib/projects/provider";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import { compareFlowVersionDetails } from "@/lib/projects/version-diff";
import { resolveVersionReadOwnerId } from "@/lib/projects/version-read-auth";
import { VersionService } from "@/lib/projects/version-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ flowId: string }>;
}

function exactVersionIds(request: Request): { readonly from: string; readonly to: string } | null {
  const parameters = new URL(request.url).searchParams;
  const keys = Array.from(parameters.keys()).sort();
  if (keys.length !== 2 || keys[0] !== "from" || keys[1] !== "to") return null;
  const from = parameters.getAll("from");
  const to = parameters.getAll("to");
  if (from.length !== 1 || to.length !== 1 || !isOpaquePathId(from[0]) || !isOpaquePathId(to[0])) {
    return null;
  }
  return { from: from[0], to: to[0] };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const ownerId = await resolveVersionReadOwnerId(request);
    const { flowId } = await context.params;
    if (!isOpaquePathId(flowId)) return notFoundResponse();
    const repo = await getProjectRepo();
    if (!(await ensureOwnedFlowContext({ repo, flowId, ownerId }))) return notFoundResponse();
    const ids = exactVersionIds(request);
    if (!ids) return invalidRequestResponse();
    const service = new VersionService(repo);
    const [left, right] = await Promise.all([
      service.getFlowVersion({ flowId, versionId: ids.from, ownerId }),
      service.getFlowVersion({ flowId, versionId: ids.to, ownerId }),
    ]);
    if (!left || !right) return notFoundResponse();
    return privateJson({ diff: compareFlowVersionDetails(left, right) });
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}
